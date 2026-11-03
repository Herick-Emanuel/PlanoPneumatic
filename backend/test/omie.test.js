const assert = require("node:assert/strict");
const { before, after, beforeEach, afterEach, test } = require("node:test");
const h = require("./helpers");
const omie = require("../services/omie");

const calls = [];
let handlers = {};
const jsonResponse = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });

before(async () => {
	await h.setup();
	omie.setTransport({
		sleep: async () => {},
		fetch: async (url, options) => {
			const body = JSON.parse(options.body);
			calls.push({ url, ...body });
			const handler = handlers[body.call];
			if (!handler) return jsonResponse({ faultstring: "Metodo nao esperado" }, 500);
			return handler(body.param[0], body);
		}
	});
});
after(h.teardown);
beforeEach(async () => {
	await h.resetDatabase();
	await h.database.query("TRUNCATE omie_sync_runs RESTART IDENTITY");
	calls.length = 0;
	handlers = {};
	process.env.OMIE_APP_KEY = "key";
	process.env.OMIE_APP_SECRET = "secret";
});
afterEach(() => { delete process.env.OMIE_APP_KEY; delete process.env.OMIE_APP_SECRET; });

const client = (code, name, document, extra = {}) => ({ codigo_cliente_omie: code, razao_social: name, cnpj_cpf: document, email: `c${code}@x.com;outro@x.com`, telefone1_ddd: "11", telefone1_numero: "99999-0000", inativo: "N", ...extra });

test("customer sync paginates, links by document, ignores invalid documents and is idempotent", async () => {
	const manager = await h.createUser("manager");
	await h.api("POST", "/api/customers", { token: manager.token, body: { name: "Local ABC", document: "11222333000181" } });
	handlers.ListarClientes = (param) => jsonResponse(param.pagina === 1
		? { pagina: 1, total_de_paginas: 2, clientes_cadastro: [client(10, "Auto Viacao ABC", "11.222.333/0001-81"), client(11, "Sem Documento", ""), client(12, "Doc Invalido", "123")] }
		: { pagina: 2, total_de_paginas: 2, clientes_cadastro: [client(13, "Inativo", "529.982.247-25", { inativo: "S" })] });
	const first = await h.api("POST", "/api/omie/sync", { token: manager.token, body: { kind: "customers" } });
	assert.equal(first.status, 200);
	assert.deepEqual([first.body.results[0].created, first.body.results[0].updated], [3, 1]);
	const { rows } = await h.database.query("SELECT name, document, omie_code, active, email, phone FROM customers ORDER BY omie_code");
	assert.equal(rows.length, 4);
	assert.equal(rows[0].name, "Auto Viacao ABC", "vinculou o cliente local pelo documento");
	assert.equal(rows[0].email, "c10@x.com", "primeiro e-mail apenas");
	assert.equal(rows[0].phone, "11 99999-0000");
	assert.equal(rows[2].document, null, "documento invalido nao e gravado");
	assert.equal(rows[3].active, false);
	assert.equal(calls[0].url.endsWith("/geral/clientes/"), true);
	assert.equal(calls[0].app_key, "key");

	const second = await h.api("POST", "/api/omie/sync", { token: manager.token, body: { kind: "customers" } });
	assert.deepEqual([second.body.results[0].created, second.body.results[0].updated], [0, 4]);
	assert.match(calls.at(-1).param[0].filtrar_por_data_de, /^\d{2}\/\d{2}\/\d{4}$/, "segunda carga e incremental");
	assert.equal((await h.api("GET", "/api/omie/sync", { token: manager.token })).body.runs.length, 2);
});

test("product sync matches by code, creates new ones and skips incomplete records", async () => {
	const manager = await h.createUser("manager");
	await h.api("POST", "/api/products", { token: manager.token, body: { code: "CP-01", description: "Antigo" } });
	handlers.ListarProdutos = () => jsonResponse({ total_de_paginas: 1, produto_servico_cadastro: [{ codigo_produto: 1, codigo: "cp-01", descricao: "Compressor" }, { codigo_produto: 2, codigo: "VL-9", descricao: "Valvula", inativo: "S" }, { codigo_produto: 3, codigo: "", descricao: "Sem codigo" }] });
	const result = await h.api("POST", "/api/omie/sync", { token: manager.token, body: { kind: "products" } });
	assert.deepEqual([result.body.results[0].created, result.body.results[0].updated, result.body.results[0].skipped], [1, 1, 1]);
	assert.equal(calls[0].param[0].filtrar_apenas_omiepdv, "N", "sem esse filtro explicito o Omie devolve 0 produtos");
	const { rows } = await h.database.query("SELECT code, description, omie_code, active FROM products ORDER BY omie_code");
	assert.deepEqual(rows.map((row) => [row.code, row.description, row.active]), [["CP-01", "Compressor", true], ["VL-9", "Valvula", false]]);
});

test("sync needs permission and configured credentials; failures are recorded", async () => {
	const operator = await h.createUser("operator");
	const manager = await h.createUser("manager");
	assert.equal((await h.api("POST", "/api/omie/sync", { token: operator.token, body: {} })).status, 403);
	delete process.env.OMIE_APP_KEY;
	const missing = await h.api("POST", "/api/omie/sync", { token: manager.token, body: {} });
	assert.equal(missing.status, 503);
	assert.equal(missing.body.code, "OMIE_NOT_CONFIGURED");
	assert.equal((await h.api("GET", "/api/omie/status", { token: operator.token })).body.configured, false);
	process.env.OMIE_APP_KEY = "key";
	handlers.ListarClientes = () => jsonResponse({ faultstring: "Application key invalida" }, 500);
	const failed = await h.api("POST", "/api/omie/sync", { token: manager.token, body: { kind: "customers" } });
	assert.equal(failed.status, 502);
	const runs = (await h.api("GET", "/api/omie/sync", { token: manager.token })).body.runs;
	assert.equal(runs[0].status, "error");
	assert.match(runs[0].message, /Application key/);
});

test("rate limit responses are retried", async () => {
	const manager = await h.createUser("manager");
	let attempts = 0;
	handlers.ListarProdutos = () => (++attempts < 3 ? jsonResponse({ faultstring: "Consumo redundante detectado" }, 500) : jsonResponse({ total_de_paginas: 1, produto_servico_cadastro: [] }));
	assert.equal((await h.api("POST", "/api/omie/sync", { token: manager.token, body: { kind: "products" } })).status, 200);
	assert.equal(attempts, 3);
});

test("order lookup returns customer and items; invoice lookup validates the document", async () => {
	const operator = await h.createUser("operator");
	await h.database.query("INSERT INTO customers (name, document, omie_code) VALUES ('Oficina Central', '11222333000181', 77)");
	handlers.ConsultarPedido = (param) => (param.numero_pedido === "1001"
		? jsonResponse({ pedido_venda_produto: { cabecalho: { codigo_pedido: 555, numero_pedido: "1001", codigo_cliente: 77 }, det: [{ produto: { codigo: "VL-52", descricao: "Valvula 5/2", quantidade: 2, valor_unitario: 150.5 } }, { produto: { codigo: "", descricao: "x" } }] } })
		: jsonResponse({ faultstring: "Pedido nao encontrado" }, 500));
	const order = await h.api("GET", "/api/omie/orders/1001", { token: operator.token });
	assert.equal(order.status, 200);
	assert.equal(order.body.order.customer.name, "Oficina Central");
	assert.deepEqual(order.body.order.items, [{ productCode: "VL-52", description: "Valvula 5/2", quantity: 2, unitPrice: 150.5 }]);
	assert.equal((await h.api("GET", "/api/omie/orders/9", { token: operator.token })).status, 404);

	handlers.ListarNF = () => jsonResponse({ nfCadastro: [{ ide: { nNF: "000123", dEmi: "02/11/2026" }, compl: { nIdPedido: 555 }, nfDestInt: { nCodCli: 77, cRazao: "Oficina Central", cnpj_cpf: "11.222.333/0001-81" } }] });
	const invoice = await h.api("GET", "/api/omie/invoices/123", { token: operator.token });
	assert.equal(invoice.status, 200);
	assert.equal(invoice.body.invoice.customer.document, "11222333000181");
	handlers.ListarNF = () => jsonResponse({ nfCadastro: [] });
	assert.equal((await h.api("GET", "/api/omie/invoices/999", { token: operator.token })).status, 404);
	const auditor = await h.createUser("auditor");
	assert.equal((await h.api("GET", "/api/omie/orders/1001", { token: auditor.token })).status, 403);
});
