// Cliente da API do Omie (https://developer.omie.com.br). As credenciais vem de OMIE_APP_KEY/OMIE_APP_SECRET.
const { database } = require("../db");
const { AppError } = require("../middleware/errors");
const { logEvent } = require("../middleware/errors");
const { isValidDocument, onlyDigits } = require("../validators/document");

const BASE_URL = process.env.OMIE_BASE_URL || "https://app.omie.com.br/api/v1";
const PAGE_SIZE = 200;
const MAX_ATTEMPTS = 4;
let fetchImplementation = (...args) => fetch(...args);
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Permite trocar fetch/sleep nos testes.
function setTransport({ fetch: nextFetch, sleep: nextSleep }) {
	if (nextFetch) fetchImplementation = nextFetch;
	if (nextSleep) sleep = nextSleep;
}

const isConfigured = () => Boolean(process.env.OMIE_APP_KEY && process.env.OMIE_APP_SECRET);

// `maxWait`: maior espera aceita por pedido de "aguarde N segundos" do Omie (consultas de tela usam pouco; rotinas em segundo plano usam mais).
async function call(endpoint, method, param, { maxWait = 8000 } = {}) {
	if (!isConfigured()) throw new AppError(503, "Integracao com o Omie nao configurada (OMIE_APP_KEY / OMIE_APP_SECRET).", "OMIE_NOT_CONFIGURED");
	const body = JSON.stringify({ call: method, app_key: process.env.OMIE_APP_KEY, app_secret: process.env.OMIE_APP_SECRET, param: [param] });
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		let response;
		try {
			response = await fetchImplementation(`${BASE_URL}/${endpoint}/`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(30000) });
		} catch (error) {
			if (attempt === MAX_ATTEMPTS) throw new AppError(502, `Nao foi possivel falar com o Omie: ${error.message}`, "OMIE_UNREACHABLE");
			await sleep(1000 * attempt);
			continue;
		}
		const data = await response.json().catch(() => ({}));
		const fault = data.faultstring || "";
		const rateLimited = response.status === 429 || response.status === 425 || /consumo redundante|aguarde|muitas requisi/i.test(fault);
		if (rateLimited) {
			const hint = Number(/aguarde (\d+) segundos/i.exec(fault)?.[1]);
			const delay = hint ? hint * 1000 + 500 : 2000 * attempt;
			if (delay > maxWait) throw new AppError(429, `O Omie pediu para aguardar ${hint || Math.round(delay / 1000)} segundos. Tente novamente em instantes.`, "OMIE_RATE_LIMIT");
			if (attempt < MAX_ATTEMPTS) { await sleep(delay); continue; }
		}
		if (!response.ok || data.faultstring) {
			const notFound = /nao encontrad|não encontrad|inexistente|nao cadastrad|não cadastrad/i.test(fault);
			throw new AppError(notFound ? 404 : 502, notFound ? "Registro nao encontrado no Omie." : `Omie respondeu com erro: ${fault || response.status}`, notFound ? "OMIE_NOT_FOUND" : "OMIE_ERROR");
		}
		return data;
	}
	throw new AppError(502, "Omie indisponivel.", "OMIE_UNREACHABLE");
}

// Percorre todas as paginas de uma listagem.
async function* paginate(endpoint, method, extra, listKey) {
	let page = 1;
	let totalPages = 1;
	do {
		const data = await call(endpoint, method, { pagina: page, registros_por_pagina: PAGE_SIZE, apenas_importado_api: "N", ...extra });
		totalPages = data.total_de_paginas || 1;
		yield data[listKey] || [];
		page += 1;
	} while (page <= totalPages);
}

const omieDate = (date) => `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
const clean = (value, max) => { const text = String(value ?? "").trim(); return text ? text.slice(0, max) : null; };

function mapCustomer(record) {
	const digits = onlyDigits(record.cnpj_cpf);
	return {
		omieCode: Number(record.codigo_cliente_omie),
		name: clean(record.razao_social || record.nome_fantasia, 180),
		document: digits && isValidDocument(digits) ? digits : null,
		email: clean(String(record.email || "").split(/[;,]/)[0], 180),
		phone: clean([record.telefone1_ddd, record.telefone1_numero].filter(Boolean).join(" "), 40),
		active: record.inativo !== "S"
	};
}

async function upsertCustomer(item) {
	const values = [item.name, item.email, item.phone, item.active];
	let result = await database.query("UPDATE customers SET name = $2, email = COALESCE($3, email), phone = COALESCE($4, phone), active = $5, omie_synced_at = NOW(), updated_at = NOW() WHERE omie_code = $1 RETURNING id", [item.omieCode, ...values]);
	if (result.rowCount) return "updated";
	if (item.document) {
		result = await database.query("UPDATE customers SET omie_code = $1, name = $3, email = COALESCE($4, email), phone = COALESCE($5, phone), active = $6, omie_synced_at = NOW(), updated_at = NOW() WHERE document = $2 AND omie_code IS NULL RETURNING id", [item.omieCode, item.document, ...values]);
		if (result.rowCount) return "updated";
	}
	await database.query("INSERT INTO customers (omie_code, name, document, email, phone, active, omie_synced_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())", [item.omieCode, item.name, item.document, item.email, item.phone, item.active]);
	return "created";
}

async function upsertProduct(record) {
	const omieCode = Number(record.codigo_produto);
	const code = clean(record.codigo, 80);
	const description = clean(record.descricao, 180);
	if (!omieCode || !code || !description) return "skipped";
	const active = record.inativo !== "S";
	let result = await database.query("UPDATE products SET code = $2, description = $3, active = $4, omie_synced_at = NOW(), updated_at = NOW() WHERE omie_code = $1 RETURNING id", [omieCode, code, description, active]);
	if (result.rowCount) return "updated";
	result = await database.query("UPDATE products SET omie_code = $1, description = $3, active = $4, omie_synced_at = NOW(), updated_at = NOW() WHERE lower(code) = lower($2) AND omie_code IS NULL RETURNING id", [omieCode, code, description, active]);
	if (result.rowCount) return "updated";
	await database.query("INSERT INTO products (omie_code, code, description, active, omie_synced_at) VALUES ($1, $2, $3, $4, NOW())", [omieCode, code, description, active]);
	return "created";
}

async function lastSuccess(kind) {
	const { rows } = await database.query("SELECT started_at FROM omie_sync_runs WHERE kind = $1 AND status = 'success' ORDER BY started_at DESC LIMIT 1", [kind]);
	return rows[0]?.started_at || null;
}

const SYNCS = {
	customers: { endpoint: "geral/clientes", method: "ListarClientes", key: "clientes_cadastro", handle: async (record) => { const item = mapCustomer(record); return item.omieCode && item.name ? upsertCustomer(item) : "skipped"; } },
	// O Omie devolve 0 produtos se filtrar_apenas_omiepdv nao for enviado explicitamente (verificado com dados reais).
	products: { endpoint: "geral/produtos", method: "ListarProdutos", key: "produto_servico_cadastro", extra: { filtrar_apenas_omiepdv: "N" }, handle: upsertProduct }
};

// Sincroniza um tipo (customers | products). Depois da primeira carga, busca so o que mudou desde a ultima execucao.
async function runSync(kind, { trigger = "manual", userId = null } = {}) {
	const spec = SYNCS[kind];
	if (!spec) throw new AppError(400, "Tipo de sincronizacao invalido.", "BAD_KIND");
	if (!isConfigured()) throw new AppError(503, "Integracao com o Omie nao configurada (OMIE_APP_KEY / OMIE_APP_SECRET).", "OMIE_NOT_CONFIGURED");
	const { rows: running } = await database.query("SELECT id FROM omie_sync_runs WHERE kind = $1 AND status = 'running' AND started_at > NOW() - INTERVAL '30 minutes'", [kind]);
	if (running[0]) throw new AppError(409, "Ja existe uma sincronizacao em andamento.", "SYNC_RUNNING");
	const since = await lastSuccess(kind);
	const filter = { ...spec.extra, ...(since ? { filtrar_por_data_de: omieDate(new Date(new Date(since).getTime() - 86400000)) } : {}) };
	const { rows } = await database.query("INSERT INTO omie_sync_runs (kind, trigger, started_by) VALUES ($1, $2, $3) RETURNING id", [kind, trigger, userId]);
	const counts = { created: 0, updated: 0, skipped: 0 };
	let errors = 0;
	try {
		for await (const records of paginate(spec.endpoint, spec.method, filter, spec.key)) {
			for (const record of records) {
				try { counts[await spec.handle(record)] += 1; } catch (error) { errors += 1; counts.skipped += 1; logEvent("omie_sync_record_error", { kind, error: error.message }); }
			}
		}
		await database.query("UPDATE omie_sync_runs SET status = 'success', finished_at = NOW(), created = $2, updated = $3, skipped = $4, message = $5 WHERE id = $1", [rows[0].id, counts.created, counts.updated, counts.skipped, errors ? `${errors} registro(s) ignorado(s) por conflito de dados` : null]);
	} catch (error) {
		await database.query("UPDATE omie_sync_runs SET status = 'error', finished_at = NOW(), created = $2, updated = $3, skipped = $4, message = $5 WHERE id = $1", [rows[0].id, counts.created, counts.updated, counts.skipped, error.message.slice(0, 500)]);
		throw error;
	}
	return { id: rows[0].id, kind, ...counts, errors };
}

async function listRuns(limit = 20) {
	const { rows } = await database.query("SELECT r.id, r.kind, r.trigger, r.status, r.created, r.updated, r.skipped, r.message, r.started_at AS \"startedAt\", r.finished_at AS \"finishedAt\", u.name AS \"startedBy\" FROM omie_sync_runs r LEFT JOIN users u ON u.id = r.started_by ORDER BY r.started_at DESC LIMIT $1", [limit]);
	return rows;
}

async function status() {
	return { configured: isConfigured(), runs: await listRuns() };
}

// Pedido de venda -> dados para abrir o processo (cliente e itens).
async function lookupOrder(orderNumber, options) {
	const data = await call("produtos/pedido", "ConsultarPedido", { numero_pedido: String(orderNumber).trim() }, options);
	const order = data.pedido_venda_produto;
	if (!order?.cabecalho) throw new AppError(404, "Pedido nao encontrado no Omie.", "OMIE_NOT_FOUND");
	const omieCustomerCode = Number(order.cabecalho.codigo_cliente);
	let customer = null;
	if (omieCustomerCode) {
		const { rows } = await database.query("SELECT id, name, document FROM customers WHERE omie_code = $1", [omieCustomerCode]);
		customer = rows[0] || null;
		if (!customer) {
			const remote = mapCustomer(await call("geral/clientes", "ConsultarCliente", { codigo_cliente_omie: omieCustomerCode }, options));
			if (remote.name) customer = { id: null, name: remote.name, document: remote.document };
		}
	}
	const items = (order.det || []).map((entry) => ({
		productCode: clean(entry.produto?.codigo, 80) || "",
		description: clean(entry.produto?.descricao, 180) || "",
		quantity: Math.max(1, Math.round(Number(entry.produto?.quantidade) || 1)),
		unitPrice: Number(entry.produto?.valor_unitario) || 0
	})).filter((item) => item.productCode && item.description);
	return { orderNumber: String(order.cabecalho.numero_pedido), omieOrderCode: Number(order.cabecalho.codigo_pedido) || null, customer, items };
}

// Nota fiscal -> confirma o documento de origem e traz o destinatario.
async function lookupInvoice(number) {
	const digits = String(number).replace(/\D/g, "");
	if (!digits) throw new AppError(400, "Informe o numero da nota fiscal.", "BAD_INVOICE");
	const data = await call("produtos/nfconsultar", "ListarNF", { pagina: 1, registros_por_pagina: 5, nNFInicial: Number(digits), nNFFinal: Number(digits) });
	const invoice = (data.nfCadastro || []).find((entry) => String(entry.ide?.nNF).replace(/^0+/, "") === digits.replace(/^0+/, ""));
	if (!invoice) throw new AppError(404, "Nota fiscal nao encontrada no Omie.", "OMIE_NOT_FOUND");
	const documentDigits = onlyDigits(invoice.nfDestInt?.cnpj_cpf);
	return {
		number: String(invoice.ide.nNF),
		emittedAt: invoice.ide.dEmi || null,
		omieOrderCode: Number(invoice.compl?.nIdPedido) || null,
		customer: { name: clean(invoice.nfDestInt?.cRazao, 180), document: documentDigits && isValidDocument(documentDigits) ? documentDigits : null, omieCode: Number(invoice.nfDestInt?.nCodCli) || null }
	};
}

// Compara as linhas do processo com as do pedido no Omie. Retorna a lista de divergencias (vazia = confere).
function compareOrderLines(omieItems, localLines) {
	const byCode = (lines) => lines.reduce((map, line) => map.set(line.productCode, { quantity: (map.get(line.productCode)?.quantity || 0) + Number(line.quantity), unitPrice: Number(line.unitPrice) || 0 }), new Map());
	const remote = byCode(omieItems);
	const local = byCode(localLines);
	const issues = [];
	for (const [code, line] of local) {
		const expected = remote.get(code);
		if (!expected) issues.push({ code, kind: "item_fora_do_pedido", local: line });
		else {
			if (expected.quantity !== line.quantity) issues.push({ code, kind: "quantidade", omie: expected.quantity, local: line.quantity });
			if (line.unitPrice && Math.abs(expected.unitPrice - line.unitPrice) > 0.009) issues.push({ code, kind: "preco", omie: expected.unitPrice, local: line.unitPrice });
		}
	}
	for (const [code, line] of remote) if (!local.has(code)) issues.push({ code, kind: "item_ausente", omie: line });
	return issues;
}

// Rotina agendada: sincroniza clientes e produtos quando a ultima execucao bem-sucedida passou do intervalo.
function startOmieScheduler(intervalHours = Number(process.env.OMIE_SYNC_INTERVAL_HOURS || 24)) {
	if (!intervalHours || intervalHours <= 0) return null;
	const tick = async () => {
		if (!isConfigured()) return;
		for (const kind of Object.keys(SYNCS)) {
			try {
				const last = await lastSuccess(kind);
				if (!last || Date.now() - new Date(last).getTime() >= intervalHours * 3600000) await runSync(kind, { trigger: "scheduled" });
			} catch (error) { logEvent("omie_scheduled_sync_error", { kind, error: error.message }); }
		}
	};
	const timer = setInterval(tick, 3600000);
	if (typeof timer.unref === "function") timer.unref();
	setTimeout(tick, 30000).unref?.();
	return timer;
}

module.exports = { compareOrderLines, setTransport, isConfigured, call, runSync, status, listRuns, lookupOrder, lookupInvoice, mapCustomer, startOmieScheduler };
