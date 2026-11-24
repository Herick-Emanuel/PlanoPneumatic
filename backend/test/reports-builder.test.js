// Importar/exportar em cada relatorio e construtor de relatorios (modelos salvos).
const assert = require("node:assert/strict");
const { before, after, beforeEach, test } = require("node:test");
const ExcelJS = require("exceljs");
const h = require("./helpers");

before(h.setup);
after(h.teardown);
beforeEach(h.resetDatabase);

const definition = (extra = {}) => ({
	source: "cases",
	columns: ["case_number", "client", "type", "status", "quantity"],
	filters: {},
	sort: { key: "case_number", direction: "asc" },
	...extra
});

test("exportar a tabela da tela em CSV, XLSX e PDF, neutralizando formulas", async () => {
	const operator = await h.createUser("operator");
	const body = {
		title: "Casos por tipo",
		format: "csv",
		columns: [
			{ key: "label", header: "Tipo" },
			{ key: "value", header: "Casos" }
		],
		rows: [
			{ label: "Garantia", value: 3 },
			{ label: "=HYPERLINK(1)", value: 1 }
		]
	};
	const csv = await h.api("POST", "/api/reports/table-export", { token: operator.token, body });
	assert.equal(csv.status, 200);
	assert.match(csv.headers.get("content-disposition"), /casos-por-tipo\.csv/);
	assert.match(csv.body, /"Tipo";"Casos"/);
	assert.match(csv.body, /"'=HYPERLINK\(1\)";"1"/);

	const xlsx = await h.api("POST", "/api/reports/table-export", { token: operator.token, body: { ...body, format: "xlsx" } });
	assert.equal(xlsx.status, 200);
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(xlsx.body);
	assert.equal(workbook.worksheets[0].getCell("A2").value, "Garantia");
	assert.equal(workbook.worksheets[0].getCell("B2").value, 3);

	const pdf = await h.api("POST", "/api/reports/table-export", { token: operator.token, body: { ...body, format: "pdf" } });
	assert.equal(pdf.status, 200);
	assert.equal(pdf.body.subarray(0, 4).toString(), "%PDF");

	const invalid = await h.api("POST", "/api/reports/table-export", { token: operator.token, body: { ...body, columns: [] } });
	assert.equal(invalid.status, 400);
});

test("abrir planilha exportada: le o XLSX e recusa arquivo que nao e planilha", async () => {
	const operator = await h.createUser("operator");
	const exported = await h.api("POST", "/api/reports/table-export", {
		token: operator.token,
		body: {
			title: "Clientes",
			format: "xlsx",
			columns: [
				{ key: "a", header: "Cliente" },
				{ key: "b", header: "Total" }
			],
			rows: [{ a: "Oficina", b: 7 }]
		}
	});
	const read = await h.api("POST", "/api/reports/import-sheet", {
		token: operator.token,
		body: { fileName: "x.xlsx", content: exported.body.toString("base64") }
	});
	assert.equal(read.status, 200);
	assert.deepEqual(read.body.columns, ["Cliente", "Total"]);
	assert.deepEqual(read.body.rows, [["Oficina", 7]]);

	const bogus = await h.api("POST", "/api/reports/import-sheet", { token: operator.token, body: { content: Buffer.from("nada").toString("base64") } });
	assert.equal(bogus.status, 400);
});

test("construtor: so gerente e administrador; lista e agrupamento respeitam o escopo", async () => {
	const admin = await h.createUser("admin");
	const manager = await h.createUser("manager");
	const operator = await h.createUser("operator");
	await h.createCase(admin.token, "Garantia", { quantity: 2, unitPrice: 10 });
	await h.createCase(admin.token, "Garantia", { quantity: 3 });
	await h.createCase(admin.token, "Pedido de venda", { quantity: 5 });

	const denied = await h.api("POST", "/api/reports/custom/preview", { token: operator.token, body: { definition: definition() } });
	assert.equal(denied.status, 403);
	assert.equal((await h.api("GET", "/api/reports/templates", { token: operator.token })).status, 403);

	const catalog = await h.api("GET", "/api/reports/custom/catalog", { token: manager.token });
	assert.equal(catalog.status, 200);
	assert.ok(catalog.body.sources.some((source) => source.key === "events"));

	const list = await h.api("POST", "/api/reports/custom/preview", { token: manager.token, body: { definition: definition() } });
	assert.equal(list.status, 200);
	assert.equal(list.body.rows.length, 3);
	assert.deepEqual(
		list.body.columns.map((column) => column.header),
		["Processo", "Cliente", "Tipo", "Status", "Quantidade"]
	);

	const grouped = await h.api("POST", "/api/reports/custom/preview", {
		token: admin.token,
		body: { definition: { source: "cases", groupBy: "type", metrics: ["count", "quantity", "value"], sort: { key: "quantity", direction: "desc" } } }
	});
	assert.equal(grouped.status, 200);
	assert.deepEqual(grouped.body.rows[0], { group: "Pedido de venda", count: 1, quantity: 5, value: 0 });
	assert.deepEqual(grouped.body.rows[1], { group: "Garantia", count: 2, quantity: 5, value: 20 });

	// Nomes de coluna fora da lista sao recusados (nada do cliente vai para o SQL).
	const injected = await h.api("POST", "/api/reports/custom/preview", {
		token: admin.token,
		body: { definition: definition({ columns: ["case_number", "password_hash"] }) }
	});
	assert.equal(injected.status, 400);

	const events = await h.api("POST", "/api/reports/custom/preview", {
		token: admin.token,
		body: { definition: { source: "events", groupBy: "case_type", metrics: ["count", "cases"] } }
	});
	assert.equal(events.status, 200);
	assert.ok(events.body.rows.some((row) => row.group === "Garantia" && row.cases === 2));

	const file = await h.api("POST", "/api/reports/custom/export", {
		token: admin.token,
		body: { definition: definition(), format: "csv", title: "Meu relatório" }
	});
	assert.equal(file.status, 200);
	assert.match(file.headers.get("content-disposition"), /meu-relatorio\.csv/);
	assert.equal(file.body.trim().split("\n").length, 4);
});

test("modelos salvos: dono altera e exclui; compartilhado aparece para os outros, so leitura", async () => {
	const manager = await h.createUser("manager");
	const other = await h.createUser("manager");
	const created = await h.api("POST", "/api/reports/templates", {
		token: manager.token,
		body: { name: "Garantias", description: "Teste", shared: false, definition: definition({ filters: { type: "Garantia" } }) }
	});
	assert.equal(created.status, 201);
	const id = created.body.template.id;
	assert.equal(created.body.template.definition.filters.type, "Garantia");
	assert.equal((await h.api("GET", "/api/reports/templates", { token: other.token })).body.templates.length, 0);

	const shared = await h.api("PUT", `/api/reports/templates/${id}`, {
		token: manager.token,
		body: { name: "Garantias (time)", shared: true, definition: definition() }
	});
	assert.equal(shared.status, 200);
	const seen = (await h.api("GET", "/api/reports/templates", { token: other.token })).body.templates;
	assert.equal(seen.length, 1);
	assert.equal(seen[0].mine, false);

	assert.equal((await h.api("PUT", `/api/reports/templates/${id}`, { token: other.token, body: { name: "x", definition: definition() } })).status, 404);
	assert.equal((await h.api("DELETE", `/api/reports/templates/${id}`, { token: other.token })).status, 404);
	assert.equal((await h.api("POST", "/api/reports/templates", { token: manager.token, body: { name: "", definition: definition() } })).status, 400);
	assert.equal((await h.api("DELETE", `/api/reports/templates/${id}`, { token: manager.token })).status, 204);
});
