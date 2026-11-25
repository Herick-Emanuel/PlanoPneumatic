// Webhook do Omie: o ERP avisa na hora quando um pedido, nota, produto ou cliente muda, e o app atualiza
// so aquele registro no espelho/cadastro. Configuracao: Portal do Desenvolvedor do Omie (developer.omie.com.br)
// > aplicativo > Webhooks, URL publica https://<app>/api/omie/webhook/<OMIE_WEBHOOK_TOKEN> (o token e criado
// por nos, nao pelo Omie). Ao salvar, o Omie manda um aviso de teste, respondido com 200.
// O aviso e respondido na hora (200) e processado em seguida, um por vez, para nao estourar o limite do Omie.
const { database } = require("../db");
const { logEvent } = require("../middleware/errors");
const omie = require("./omie");
const mirror = require("./omieMirror");

let queue = Promise.resolve();
const idle = () => queue;

// Procura no evento o primeiro campo cujo nome bate com o padrao (o Omie varia o nome entre topicos).
function pick(event, pattern) {
	if (!event || typeof event !== "object") return null;
	for (const [key, value] of Object.entries(event)) {
		if (pattern.test(key) && value !== null && value !== "" && typeof value !== "object") return value;
	}
	for (const value of Object.values(event)) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const found = pick(value, pattern);
			if (found !== null) return found;
		}
	}
	return null;
}

const background = { maxWait: omie.BACKGROUND_WAIT };

// Um sync incremental por tipo de cada vez; avisos em rajada viram uma unica rodada.
async function incremental(kind) {
	try {
		await omie.runSync(kind, { trigger: "webhook" });
	} catch (error) {
		if (error.code !== "SYNC_RUNNING") throw error;
	}
}

const HANDLERS = [
	{
		match: /^VendaProduto\./i,
		async run(event) {
			const code = Number(pick(event, /^(idPedido|codigo_pedido|nCodPed)$/i));
			if (!code) return incremental("orders");
			const data = await omie.call("produtos/pedido", "ConsultarPedido", { codigo_pedido: code }, background);
			if (data.pedido_venda_produto?.cabecalho) await mirror.upsertOrder(data.pedido_venda_produto);
			return null;
		}
	},
	{
		match: /^(NFe|NF|NotaFiscal)\./i,
		async run(event) {
			const number = Number(String(pick(event, /^(nNF|numero_nf|numeroNF|nNumero)$/i) || "").replace(/\D/g, ""));
			if (!number) return incremental("invoices");
			const data = await omie.call(
				"produtos/nfconsultar",
				"ListarNF",
				{ pagina: 1, registros_por_pagina: 20, nNFInicial: number, nNFFinal: number },
				background
			);
			for (const invoice of data.nfCadastro || []) await mirror.upsertInvoice(invoice);
			return null;
		}
	},
	{
		match: /^Produto\./i,
		async run(event) {
			const code = Number(pick(event, /^(codigo_produto|nCodProd|idProduto)$/i));
			if (!code) return incremental("products");
			const data = await omie.call("geral/produtos", "ConsultarProduto", { codigo_produto: code }, background);
			await omie.upsertProduct(data);
			return null;
		}
	},
	{
		match: /^ClienteFornecedor\./i,
		async run(event) {
			const code = Number(pick(event, /^(codigo_cliente_omie|codigo_cliente|nCodCli)$/i));
			if (!code) return incremental("customers");
			const item = omie.mapCustomer(await omie.call("geral/clientes", "ConsultarCliente", { codigo_cliente_omie: code }, background));
			if (item.omieCode && item.name) await omie.upsertCustomer(item);
			return null;
		}
	}
];

async function processEvent(id, topic, event) {
	const handler = HANDLERS.find((entry) => entry.match.test(topic));
	try {
		if (handler) await handler.run(event || {});
		await database.query("UPDATE omie_webhook_events SET processed_at = NOW(), error = NULL WHERE id = $1", [id]);
	} catch (error) {
		await database.query("UPDATE omie_webhook_events SET processed_at = NOW(), error = $2 WHERE id = $1", [id, String(error.message).slice(0, 500)]);
		logEvent("omie_webhook_error", { topic, error: error.message });
	}
}

/** Guarda o aviso (ignora repetidos pelo messageId) e agenda o processamento. Retorna se foi aceito. */
async function receive(body) {
	const topic = String(body?.topic || "").slice(0, 120);
	if (!topic) return { accepted: false, reason: "ping" }; // teste de conexao do Omie ao cadastrar o webhook
	const messageId = body.messageId ? String(body.messageId).slice(0, 120) : null;
	const { rows } = await database.query(
		"INSERT INTO omie_webhook_events (message_id, topic, payload) VALUES ($1, $2, $3) ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id",
		[messageId, topic, body]
	);
	if (!rows[0]) return { accepted: false, reason: "duplicate" };
	const { id } = rows[0];
	queue = queue.then(() => processEvent(id, topic, body.event));
	return { accepted: true, id };
}

module.exports = { receive, idle, pick };
