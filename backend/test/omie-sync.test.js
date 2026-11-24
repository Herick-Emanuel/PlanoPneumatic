// Omie <-> app: espelho incremental de pedidos/notas, webhook em tempo real e envio de pecas com aprovacao.
const assert = require("node:assert/strict");
const { before, after, beforeEach, afterEach, test } = require("node:test");
const h = require("./helpers");
const omie = require("../services/omie");
const omieWebhook = require("../services/omieWebhook");
const omieProducts = require("../services/omieProducts");

const calls = [];
let handlers = {};
const jsonResponse = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });
const fault = (message) => jsonResponse({ faultstring: message }, 500);

before(async () => {
	await h.setup();
	omie.setTransport({
		sleep: async () => {},
		fetch: async (url, options) => {
			const body = JSON.parse(options.body);
			calls.push({ url, call: body.call, param: body.param[0] });
			const handler = handlers[body.call];
			if (!handler) return fault("Metodo nao esperado");
			return handler(body.param[0]);
		}
	});
});
after(h.teardown);
beforeEach(async () => {
	await h.resetDatabase();
	await h.database.query("TRUNCATE omie_sync_runs, omie_orders, omie_invoices, omie_webhook_events RESTART IDENTITY");
	calls.length = 0;
	handlers = {};
	process.env.OMIE_APP_KEY = "key";
	process.env.OMIE_APP_SECRET = "secret";
	process.env.OMIE_WEBHOOK_TOKEN = "token-secreto-do-webhook";
});
afterEach(async () => {
	await omieWebhook.idle();
	await omieProducts.idle();
	for (const name of ["OMIE_APP_KEY", "OMIE_APP_SECRET", "OMIE_WEBHOOK_TOKEN"]) delete process.env[name];
});

const order = (code, extra = {}) => ({
	cabecalho: { codigo_pedido: code, numero_pedido: String(1000 + code), codigo_cliente: 77 },
	infoCadastro: { dInc: "10/11/2026", faturado: "N", cancelado: "N", ...extra },
	total_pedido: { valor_total_pedido: 100 },
	det: [{ produto: { codigo: "VL-52", descricao: "Valvula 5/2", quantidade: 1, valor_unitario: 100 } }]
});
const webhook = (body, token = "token-secreto-do-webhook") => h.api("POST", `/api/omie/webhook/${token}`, { body });

test("espelho: primeira carga completa, depois so o que mudou (por data de alteracao)", async () => {
	const manager = await h.createUser("manager");
	let invoiced = "N";
	handlers.ListarPedidos = () => jsonResponse({ total_de_paginas: 1, pedido_venda_produto: [order(1), order(2, { faturado: invoiced })] });
	const first = await h.api("POST", "/api/omie/sync", { token: manager.token, body: { kind: "orders" } });
	assert.equal(first.body.results[0].created, 2);
	assert.equal(calls[0].param.filtrar_por_data_de, undefined, "primeira carga sem filtro de data");

	invoiced = "S";
	calls.length = 0;
	const second = await h.api("POST", "/api/omie/mirror/refresh", { token: manager.token, body: { kind: "orders" } });
	assert.equal(second.status, 200);
	assert.equal(second.body.result.updated, 2);
	assert.match(calls[0].param.filtrar_por_data_de, /^\d{2}\/\d{2}\/\d{4}$/);
	assert.equal(calls[0].param.filtrar_apenas_alteracao, "S");
	const list = await h.api("GET", "/api/omie/orders", { token: manager.token });
	assert.equal(list.body.orders.find((row) => row.number === "1002").invoiced, true);

	const status = await h.api("GET", "/api/omie/mirror", { token: manager.token });
	assert.equal(status.body.orders.count, 2);
	assert.equal(status.body.webhook, true);
	const operator = await h.createUser("operator");
	assert.equal((await h.api("GET", "/api/omie/mirror", { token: operator.token })).status, 403);
});

test("webhook: token e app_key conferidos, aviso repetido ignorado, registro atualizado na hora", async () => {
	handlers.ConsultarPedido = (param) => jsonResponse({ pedido_venda_produto: order(param.codigo_pedido, { faturado: "S" }) });
	handlers.ListarNF = () =>
		jsonResponse({
			nfCadastro: [{ ide: { nNF: "000456", serie: "1", dEmi: "12/11/2026", tpNF: "1" }, compl: { nIdNF: 9 }, nfDestInt: { nCodCli: 77 }, det: [] }]
		});
	handlers.ConsultarProduto = () => jsonResponse({ codigo_produto: 55, codigo: "NOVO-1", descricao: "Peca criada no Omie" });

	assert.equal((await webhook({ topic: "VendaProduto.Alterada", event: { idPedido: 5 } }, "errado")).status, 404);
	assert.equal((await webhook({ topic: "VendaProduto.Alterada", appKey: "outra", event: { idPedido: 5 } })).status, 404);
	const ping = await webhook({ ping: "omie" });
	assert.equal(ping.status, 200);
	assert.equal(ping.body.accepted, false);

	const first = await webhook({ messageId: "m-1", topic: "VendaProduto.Alterada", appKey: "key", event: { idPedido: 5, numeroPedido: "1005" } });
	assert.equal(first.status, 200);
	assert.equal(first.body.accepted, true);
	assert.equal((await webhook({ messageId: "m-1", topic: "VendaProduto.Alterada", event: { idPedido: 5 } })).body.accepted, false);
	await webhook({ messageId: "m-2", topic: "NFe.NotaAutorizada", event: { numero_nf: "456" } });
	await webhook({ messageId: "m-3", topic: "Produto.Incluido", event: { codigo_produto: 55 } });
	await omieWebhook.idle();

	const { rows: orders } = await h.database.query("SELECT number, invoiced FROM omie_orders");
	assert.deepEqual(orders, [{ number: "1005", invoiced: true }]);
	const { rows: invoices } = await h.database.query("SELECT ref, nf_type FROM omie_invoices");
	assert.deepEqual(invoices, [{ ref: "456", nf_type: "saida" }]);
	const { rows: products } = await h.database.query("SELECT code, omie_code, omie_status FROM products");
	assert.deepEqual(products, [{ code: "NOVO-1", omie_code: "55", omie_status: "synced" }]);
	const { rows: events } = await h.database.query("SELECT topic, processed_at IS NOT NULL AS done, error FROM omie_webhook_events ORDER BY id");
	assert.equal(events.length, 3);
	assert.ok(events.every((event) => event.done && !event.error));
	assert.equal(calls.filter((call) => call.call === "ConsultarPedido").length, 1, "o aviso repetido nao consulta de novo");
});

test("peca nova: aguarda aprovacao; quem aprova informa NCM; cria no Omie com codigo de integracao", async () => {
	const manager = await h.createUser("manager");
	const operator = await h.createUser("operator");
	const missingUnit = await h.api("POST", "/api/products", { token: operator.token, body: { code: "VL-77", description: "Valvula nova" } });
	assert.equal(missingUnit.status, 400);
	const created = await h.api("POST", "/api/products", {
		token: operator.token,
		body: { code: "VL-77", description: "Valvula nova", unit: "pc", referencePrice: "150,50" }
	});
	assert.equal(created.status, 201);
	const product = created.body.product;
	assert.equal(product.omieStatus, "pending_approval");
	assert.equal(product.unit, "PC");
	assert.equal(Number(product.referencePrice), 150.5);

	assert.equal(
		(await h.api("POST", "/api/omie/products/approve", { token: operator.token, body: { items: [{ id: product.id, ncm: "84812090" }] } })).status,
		403
	);
	const badNcm = await h.api("POST", "/api/omie/products/approve", { token: manager.token, body: { items: [{ id: product.id, ncm: "123" }] } });
	assert.equal(badNcm.body.results[0].status, "error");
	assert.match(badNcm.body.results[0].message, /NCM/);

	handlers.ConsultarProduto = () => fault("ERROR: Produto nao cadastrado para o Codigo informado");
	handlers.IncluirProduto = () => jsonResponse({ codigo_produto: 9001, codigo_status: "0", descricao_status: "Produto cadastrado com sucesso!" });
	const approved = await h.api("POST", "/api/omie/products/approve", { token: manager.token, body: { items: [{ id: product.id, ncm: "84812090" }] } });
	assert.equal(approved.body.queued, 1);
	await omieProducts.idle();
	const sent = calls.find((call) => call.call === "IncluirProduto").param;
	assert.equal(sent.codigo_produto_integracao, `PP-${product.id}`);
	assert.equal(sent.codigo, "VL-77");
	assert.equal(sent.ncm, "8481.20.90");
	assert.equal(sent.unidade, "PC");
	assert.equal(sent.valor_unitario, 150.5);
	const { rows } = await h.database.query("SELECT omie_code, omie_status, omie_approved_by FROM products WHERE id = $1", [product.id]);
	assert.deepEqual(rows[0], { omie_code: "9001", omie_status: "synced", omie_approved_by: manager.id });
	const audit = await h.database.query("SELECT action FROM audit_log WHERE entity_type = 'product' ORDER BY id");
	assert.deepEqual(
		audit.rows.map((row) => row.action),
		["Peça aprovada para envio ao Omie", "Peça cadastrada no Omie"]
	);
});

test("peca que ja existe no Omie so liga os cadastros; envio em lote inclui pecas antigas", async () => {
	const supervisor = await h.createUser("supervisor");
	// Peca antiga (antes desta mudanca): sem situacao de envio.
	const { rows } = await h.database.query(
		"INSERT INTO products (code, description, unit) VALUES ('CP-01', 'Compressor', 'UN'), ('CP-02', 'Cabecote', NULL) RETURNING id"
	);
	handlers.ConsultarProduto = (param) => (param.codigo === "CP-01" ? jsonResponse({ codigo_produto: 700, codigo: "CP-01" }) : fault("Produto nao cadastrado"));
	handlers.IncluirProduto = () => jsonResponse({ codigo_produto: 701 });
	const batch = await h.api("POST", "/api/omie/products/approve", {
		token: supervisor.token,
		body: {
			items: [
				{ id: rows[0].id, ncm: "8414.80.19" },
				{ id: rows[1].id, ncm: "8414.90.39", unit: "kit" }
			]
		}
	});
	assert.equal(batch.body.queued, 2);
	await omieProducts.idle();
	const { rows: after } = await h.database.query("SELECT code, omie_code, omie_status, unit FROM products ORDER BY code");
	assert.deepEqual(after, [
		{ code: "CP-01", omie_code: "700", omie_status: "synced", unit: "UN" },
		{ code: "CP-02", omie_code: "701", omie_status: "synced", unit: "KIT" }
	]);
	assert.equal(calls.filter((call) => call.call === "IncluirProduto").length, 1, "CP-01 ja existia: nao inclui de novo");
	const again = await h.api("POST", "/api/omie/products/approve", { token: supervisor.token, body: { items: [{ id: rows[0].id, ncm: "8414.80.19" }] } });
	assert.equal(again.body.results[0].status, "skipped");
});

test("erro de dados espera correcao e reenvio; Omie fora do ar tenta de novo sozinho", async () => {
	const manager = await h.createUser("manager");
	const { rows } = await h.database.query(
		"INSERT INTO products (code, description, unit, omie_status) VALUES ('X-1', 'Peca X', 'UN', 'pending_approval') RETURNING id"
	);
	const id = rows[0].id;
	handlers.ConsultarProduto = () => fault("Produto nao cadastrado");
	handlers.IncluirProduto = () => fault("ERROR: NCM [8414.80.19] invalido!");
	await h.api("POST", "/api/omie/products/approve", { token: manager.token, body: { items: [{ id, ncm: "84148019" }] } });
	await omieProducts.idle();
	let product = (await h.api("GET", "/api/products?includeInactive=true", { token: manager.token })).body.products[0];
	assert.equal(product.omieStatus, "error");
	assert.match(product.omieError, /NCM/);
	assert.equal(product.omieNextAttemptAt, null, "erro de dados nao tenta sozinho");

	// Omie fora do ar: agenda nova tentativa automatica.
	handlers.IncluirProduto = () => {
		throw new Error("ECONNRESET");
	};
	assert.equal((await h.api("POST", `/api/omie/products/${id}/retry`, { token: manager.token, body: {} })).status, 200);
	await omieProducts.idle();
	product = (await h.api("GET", "/api/products?includeInactive=true", { token: manager.token })).body.products[0];
	assert.equal(product.omieStatus, "error");
	assert.ok(product.omieNextAttemptAt, "falha temporaria agenda nova tentativa");

	// Chegou a hora: a rotina agendada reenvia e o Omie ja respondeu.
	handlers.IncluirProduto = () => jsonResponse({ codigo_produto: 42 });
	await h.database.query("UPDATE products SET omie_next_attempt_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [id]);
	await omieProducts.retryDue();
	await omieProducts.idle();
	const { rows: done } = await h.database.query("SELECT omie_status, omie_code FROM products WHERE id = $1", [id]);
	assert.deepEqual(done[0], { omie_status: "synced", omie_code: "42" });
	assert.equal((await h.api("POST", `/api/omie/products/${id}/retry`, { token: manager.token, body: {} })).status, 409);
});

test("sem Omie configurado a peca nova funciona como antes", async () => {
	delete process.env.OMIE_APP_KEY;
	const operator = await h.createUser("operator");
	const created = await h.api("POST", "/api/products", { token: operator.token, body: { code: "SEM-OMIE", description: "Peca local" } });
	assert.equal(created.status, 201);
	assert.equal(created.body.product.omieStatus, null);
	const list = await h.api("GET", "/api/products", { token: operator.token });
	assert.equal(list.body.omieConfigured, false);
});
