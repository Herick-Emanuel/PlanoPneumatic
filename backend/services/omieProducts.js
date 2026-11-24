// Envio de pecas do app para o Omie (requisito "cadastrar peca do app no Omie").
// Fluxo: peca nova fica "Aguardando aprovacao" -> quem aprova informa o NCM (e confere a unidade) ->
// consulta o Omie pelo codigo: se ja existe, so liga os cadastros; senao inclui com
// codigo_produto_integracao = PP-<id> (um reenvio nunca cria duas vezes).
// Falha temporaria (Omie fora, limite) tenta de novo sozinha ate 3 vezes; erro de dados espera correcao.
const { database } = require("../db");
const { AppError, logEvent } = require("../middleware/errors");
const { audit, AUDIT_ACTIONS } = require("./audit");
const omie = require("./omie");

const UNITS = Object.freeze(["UN", "PC", "KIT", "CJ", "M", "L"]);
const RETRY_MINUTES = [1, 5, 15];
const MAX_AUTO_ATTEMPTS = RETRY_MINUTES.length;
const STATUS_LABELS = Object.freeze({
	pending_approval: "Aguardando aprovação",
	sending: "Enviando",
	synced: "No Omie",
	error: "Erro no envio",
	null: "Não enviada"
});

// "00000000" ou "0000.00.00" -> "0000.00.00" (formato aceito pelo Omie); invalido -> null.
function normalizeNcm(value) {
	const digits = String(value || "").replace(/\D/g, "");
	return digits.length === 8 ? `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}` : null;
}

const integrationCode = (id) => `PP-${id}`;
const temporary = (error) => ["OMIE_UNREACHABLE", "OMIE_RATE_LIMIT"].includes(error?.code) || (error?.status >= 500 && error?.code !== "OMIE_ERROR");

let queue = Promise.resolve();
const idle = () => queue;

async function consult(param) {
	try {
		return await omie.call("geral/produtos", "ConsultarProduto", param, { maxWait: omie.BACKGROUND_WAIT });
	} catch (error) {
		if (error.code === "OMIE_NOT_FOUND") return null;
		throw error;
	}
}

async function markSynced(product, omieCode, linked, actorId) {
	await database.query(
		"UPDATE products SET omie_code = $2, omie_status = 'synced', omie_error = NULL, omie_next_attempt_at = NULL, omie_sent_at = NOW(), omie_synced_at = NOW(), updated_at = NOW() WHERE id = $1",
		[product.id, omieCode]
	);
	await audit(linked ? AUDIT_ACTIONS.OMIE_PRODUCT_LINKED : AUDIT_ACTIONS.OMIE_PRODUCT_SENT, {
		actorId,
		entityType: "product",
		entityId: product.id,
		details: { code: product.code, omieCode }
	});
	return { status: "synced", linked, omieCode };
}

// Envia uma peca agora (usado pela fila). Nunca lanca: grava o resultado na peca.
async function send(productId, actorId = null) {
	const { rows } = await database.query("SELECT * FROM products WHERE id = $1", [productId]);
	const product = rows[0];
	if (!product || product.omie_status !== "sending") return { status: "skipped" };
	try {
		// 1) Ja existe no Omie com o mesmo codigo? So liga os cadastros.
		const existing = (await consult({ codigo: product.code })) || (await consult({ codigo_produto_integracao: integrationCode(product.id) }));
		if (existing?.codigo_produto) return await markSynced(product, Number(existing.codigo_produto), true, actorId);
		// 2) Inclui.
		const payload = {
			codigo_produto_integracao: integrationCode(product.id),
			codigo: product.code,
			descricao: product.description,
			unidade: product.unit,
			ncm: product.ncm,
			...(product.reference_price ? { valor_unitario: Number(product.reference_price) } : {})
		};
		let created;
		try {
			created = await omie.call("geral/produtos", "IncluirProduto", payload, { maxWait: omie.BACKGROUND_WAIT });
		} catch (error) {
			// Corrida com outro envio: o codigo de integracao ja existe -> consulta e liga.
			if (/j[aá] cadastrad|j[aá] existe/i.test(error.message)) {
				const again = await consult({ codigo_produto_integracao: integrationCode(product.id) });
				if (again?.codigo_produto) return await markSynced(product, Number(again.codigo_produto), true, actorId);
			}
			throw error;
		}
		if (!created?.codigo_produto) throw new AppError(502, `Omie nao confirmou o cadastro: ${created?.descricao_status || "sem codigo"}`, "OMIE_ERROR");
		return await markSynced(product, Number(created.codigo_produto), false, actorId);
	} catch (error) {
		const attempts = product.omie_attempts + 1;
		const retry = temporary(error) && attempts <= MAX_AUTO_ATTEMPTS;
		const message = String(error.message || "Falha no envio").slice(0, 500);
		await database.query(
			"UPDATE products SET omie_status = 'error', omie_error = $2, omie_attempts = $3, omie_next_attempt_at = $4, updated_at = NOW() WHERE id = $1",
			[product.id, message, attempts, retry ? new Date(Date.now() + RETRY_MINUTES[attempts - 1] * 60000) : null]
		);
		await audit(AUDIT_ACTIONS.OMIE_PRODUCT_FAILED, {
			actorId,
			entityType: "product",
			entityId: product.id,
			details: { code: product.code, error: message, willRetry: retry }
		});
		logEvent("omie_product_send_error", { productId: product.id, error: message, willRetry: retry });
		return { status: "error", message, willRetry: retry };
	}
}

function enqueue(productId, actorId) {
	queue = queue.then(() => send(productId, actorId));
	return queue;
}

/**
 * Aprova e envia (individual ou em lote). items: [{ id, ncm, unit? }]. Valida tudo antes; cada peca valida
 * vai para a fila e a resposta volta na hora (a tela acompanha pela situacao).
 */
async function approve(user, items) {
	if (!omie.isConfigured()) throw new AppError(503, "Integracao com o Omie nao configurada (OMIE_APP_KEY / OMIE_APP_SECRET).", "OMIE_NOT_CONFIGURED");
	const results = [];
	for (const item of items) {
		const ncm = normalizeNcm(item.ncm);
		const { rows } = await database.query("SELECT id, code, unit, omie_status, active FROM products WHERE id = $1", [item.id]);
		const product = rows[0];
		const unit = String(item.unit || product?.unit || "").toUpperCase();
		if (!product) results.push({ id: item.id, status: "error", message: "Peça não encontrada." });
		else if (product.omie_status === "synced") results.push({ id: item.id, status: "skipped", message: "Já está no Omie." });
		else if (product.omie_status === "sending") results.push({ id: item.id, status: "skipped", message: "Envio já em andamento." });
		else if (!ncm) results.push({ id: item.id, code: product.code, status: "error", message: "NCM inválido: informe 8 dígitos (0000.00.00)." });
		else if (!UNITS.includes(unit)) results.push({ id: item.id, code: product.code, status: "error", message: `Unidade inválida: use ${UNITS.join(", ")}.` });
		else {
			await database.query(
				"UPDATE products SET ncm = $2, unit = $3, omie_status = 'sending', omie_error = NULL, omie_attempts = 0, omie_next_attempt_at = NULL, omie_approved_by = $4, omie_approved_at = NOW(), updated_at = NOW() WHERE id = $1",
				[product.id, ncm, unit, user.id]
			);
			await audit(AUDIT_ACTIONS.OMIE_PRODUCT_APPROVED, {
				actorId: user.id,
				entityType: "product",
				entityId: product.id,
				details: { code: product.code, ncm, unit }
			});
			enqueue(product.id, user.id);
			results.push({ id: product.id, code: product.code, status: "queued" });
		}
	}
	return { results, queued: results.filter((entry) => entry.status === "queued").length };
}

// "Reenviar ao Omie" depois de corrigir (ou sem esperar a proxima tentativa automatica).
async function retry(user, id) {
	const { rows } = await database.query("SELECT id, code, ncm, unit, omie_status FROM products WHERE id = $1", [id]);
	if (!rows[0]) throw new AppError(404, "Peça não encontrada.", "NOT_FOUND");
	if (rows[0].omie_status !== "error") throw new AppError(409, "Só peças com erro no envio podem ser reenviadas.", "BAD_STATE");
	await audit(AUDIT_ACTIONS.OMIE_PRODUCT_RETRY, { actorId: user.id, entityType: "product", entityId: id, details: { code: rows[0].code } });
	return approve(user, [{ id, ncm: rows[0].ncm, unit: rows[0].unit }]);
}

// Chamado pela rotina agendada: reenvia o que falhou por instabilidade e chegou a hora.
async function retryDue() {
	if (!omie.isConfigured()) return;
	const { rows } = await database.query(
		"UPDATE products SET omie_status = 'sending' WHERE omie_status = 'error' AND omie_next_attempt_at <= NOW() RETURNING id"
	);
	for (const row of rows) await enqueue(row.id, null);
}

// Situacao inicial de uma peca criada no app.
const initialStatus = () => (omie.isConfigured() ? "pending_approval" : null);

module.exports = { UNITS, STATUS_LABELS, normalizeNcm, approve, retry, retryDue, send, idle, initialStatus, integrationCode };
