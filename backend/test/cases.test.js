const assert = require("node:assert/strict");
const { before, after, beforeEach, test } = require("node:test");
const h = require("./helpers");

before(h.setup);
after(h.teardown);
beforeEach(h.resetDatabase);

test("each case type persists its specific fields (F1)", async () => {
	const operator = await h.createUser("operator");
	const venda = await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Pedido de venda", { salesRepresentative: "Joana", unitPrice: "1.234,50", paymentTerms: "28 dias", salesChannel: "Balcao" }) });
	assert.equal(venda.status, 201);
	const troca = await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Base de troca", { originOrder: "PV-2026-0001", trackingCode: "BR123", itemCondition: "Dano leve", exchangeReason: "Dano no transporte" }) });
	assert.equal(troca.status, 201);
	const garantia = await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Garantia", { receivedAt: "2026-05-02", defectDescription: "Vazamento", riskLevel: "Alto", serialNumber: "SN-1", lotNumber: "L-9" }) });
	assert.equal(garantia.status, 201);

	const vendaDetail = (await h.api("GET", `/api/cases/${venda.body.case.id}`, { token: operator.token })).body.case;
	assert.equal(vendaDetail.salesRepresentative, "Joana");
	assert.equal(vendaDetail.unitPrice, 1234.5);
	assert.equal(vendaDetail.paymentTerms, "28 dias");
	assert.equal(vendaDetail.salesChannel, "Balcao");
	const trocaDetail = (await h.api("GET", `/api/cases/${troca.body.case.id}`, { token: operator.token })).body.case;
	assert.equal(trocaDetail.originOrder, "PV-2026-0001");
	assert.equal(trocaDetail.itemCondition, "Dano leve");
	assert.equal(trocaDetail.exchangeReason, "Dano no transporte");
	const garantiaDetail = (await h.api("GET", `/api/cases/${garantia.body.case.id}`, { token: operator.token })).body.case;
	assert.equal(garantiaDetail.receivedAt, "2026-05-02");
	assert.equal(garantiaDetail.riskLevel, "Alto");
	assert.equal(garantiaDetail.serialNumber, "SN-1");
	assert.equal(garantiaDetail.checklist.length, 3);
	assert.ok(garantiaDetail.dueAt);
});

test("server-side validation: document check digit, exchange fields, quantity", async () => {
	const operator = await h.createUser("operator");
	const invalidDocument = await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Garantia", { clientDocument: "111.111.111-11" }) });
	assert.equal(invalidDocument.status, 400);
	assert.match(invalidDocument.body.message, /CPF ou CNPJ/);
	const validCpf = await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Garantia", { clientDocument: "529.982.247-25" }) });
	assert.equal(validCpf.status, 201);
	const missingExchange = await h.api("POST", "/api/cases", { token: operator.token, body: { type: "Base de troca", client: "A", product: "B", productCode: "C", quantity: 1 } });
	assert.equal(missingExchange.status, 400);
	const intake = await h.api("POST", "/api/cases", { token: operator.token, body: { type: "Base de troca", client: "A", product: "B", productCode: "C", quantity: 1, intake: true } });
	assert.equal(intake.status, 201, "a triagem rapida aceita a troca sem os campos especificos");
	const manager = await h.createUser("manager");
	await h.api("PATCH", `/api/cases/${intake.body.case.id}/status`, { token: manager.token, body: { status: "Em analise" } });
	const early = await h.api("PATCH", `/api/cases/${intake.body.case.id}/status`, { token: manager.token, body: { status: "Aprovado" } });
	assert.equal(early.body.code, "FIELDS_REQUIRED");
	assert.equal((await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Garantia", { quantity: 0 }) })).status, 400);
	assert.equal((await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Outro") })).status, 400);
});

test("100 concurrent creations never repeat a case number", async () => {
	const operator = await h.createUser("operator");
	const results = await Promise.all(Array.from({ length: 100 }, () => h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Pedido de venda") })));
	assert.ok(results.every((response) => response.status === 201), "todas as criacoes devem funcionar");
	const numbers = results.map((response) => response.body.case.id);
	assert.equal(new Set(numbers).size, 100);
	const year = new Date().getFullYear();
	assert.ok(numbers.includes(`PV-${year}-0100`));
});

test("sequence restarts per year and continues from existing numbers", async () => {
	const operator = await h.createUser("operator");
	await h.database.query("INSERT INTO case_sequences (prefix, year, last_value) VALUES ('GAR', 2020, 187)");
	const first = await h.createCase(operator.token, "Garantia");
	assert.equal(first, `GAR-${new Date().getFullYear()}-0001`);
});

test("transition rules: invalid jumps, roles, reasons (F2)", async () => {
	const operator = await h.createUser("operator");
	const manager = await h.createUser("manager");
	const caseNumber = await h.createCase(operator.token, "Base de troca");
	const status = (token, body) => h.api("PATCH", `/api/cases/${caseNumber}/status`, { token, body });

	assert.equal((await status(operator.token, { status: "Concluido" })).status, 422, "Criado nao vai direto a Concluido");
	assert.equal((await status(operator.token, { status: "Em analise" })).status, 200);
	assert.equal((await status(operator.token, { status: "Aprovado" })).status, 403, "operador nao decide");
	assert.equal((await status(manager.token, { status: "Improcedente" })).status, 422, "improcedente exige motivo");
	assert.equal((await status(manager.token, { status: "Improcedente", reason: "Fora da politica" })).status, 200);
	assert.equal((await status(manager.token, { status: "Aprovado" })).status, 422, "Improcedente so vai para Encerrado");
	assert.equal((await status(manager.token, { status: "Encerrado" })).status, 200);

	const detail = (await h.api("GET", `/api/cases/${caseNumber}`, { token: manager.token })).body.case;
	assert.equal(detail.statusReason, "");
	assert.ok(detail.events.some((event) => event.description.includes("Fora da politica")));

	assert.equal((await status(operator.token, { status: "Em analise", reason: "voltou" })).status, 403, "operador nao reabre");
	assert.equal((await status(manager.token, { status: "Em analise" })).status, 422, "reabertura exige justificativa");
	assert.equal((await status(manager.token, { status: "Em analise", reason: "Cliente enviou nova evidencia" })).status, 200);
	const reopened = (await h.api("GET", `/api/cases/${caseNumber}`, { token: manager.token })).body.case;
	assert.equal(reopened.status, "Em analise");
	assert.equal(reopened.reopenCount, 1);
});

test("cannot close with pending checklist or without documents; allowedTransitions reflects the role", async () => {
	const operator = await h.createUser("operator");
	const manager = await h.createUser("manager");
	const caseNumber = await h.createCase(operator.token, "Pedido de venda");
	const status = (body, token = manager.token) => h.api("PATCH", `/api/cases/${caseNumber}/status`, { token, body });
	await status({ status: "Em analise" });
	await status({ status: "Aprovado" });
	await status({ status: "Em faturamento" });
	const blockedChecklist = await status({ status: "Concluido" });
	assert.equal(blockedChecklist.status, 422);
	assert.equal(blockedChecklist.body.code, "CHECKLIST_PENDING");

	const detail = (await h.api("GET", `/api/cases/${caseNumber}`, { token: manager.token })).body.case;
	for (const item of detail.checklist) await h.api("PATCH", `/api/cases/${caseNumber}/checklist/${item.id}`, { token: operator.token, body: { completed: true } });
	const blockedDocument = await status({ status: "Concluido" });
	assert.equal(blockedDocument.body.code, "DOCUMENT_REQUIRED");

	const upload = await h.api("POST", `/api/cases/${caseNumber}/attachments/upload?kind=comprovante`, { token: operator.token, raw: h.PNG, headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("comprovante.png") } });
	assert.equal(upload.status, 201);
	assert.equal((await status({ status: "Concluido" })).status, 200);

	const operatorView = (await h.api("GET", `/api/cases/${caseNumber}`, { token: operator.token })).body.case;
	assert.deepEqual(operatorView.allowedTransitions, []);
	const managerView = (await h.api("GET", `/api/cases/${caseNumber}`, { token: manager.token })).body.case;
	assert.deepEqual(managerView.allowedTransitions, ["Encerrado"]);
});

test("warranty needs a technical report before approval and stores decision and destination (F5)", async () => {
	const operator = await h.createUser("operator");
	const technician = await h.createUser("technician");
	const caseNumber = await h.createCase(operator.token, "Garantia");
	await h.api("PATCH", `/api/cases/${caseNumber}/status`, { token: operator.token, body: { status: "Em analise" } });
	const early = await h.api("PATCH", `/api/cases/${caseNumber}/status`, { token: technician.token, body: { status: "Aprovado", destination: "reposicao" } });
	assert.equal(early.body.code, "REPORT_REQUIRED");

	assert.equal((await h.api("PATCH", `/api/cases/${caseNumber}`, { token: operator.token, body: { technicalReport: "x" } })).status, 403, "operador nao escreve laudo");
	const report = await h.api("PATCH", `/api/cases/${caseNumber}`, { token: technician.token, body: { technicalReport: "Vedacao rompida por defeito de fabricacao.", technicalOwnerId: technician.id } });
	assert.equal(report.status, 200);
	assert.equal((await h.api("PATCH", `/api/cases/${caseNumber}/status`, { token: technician.token, body: { status: "Aprovado" } })).body.code, "DESTINATION_REQUIRED");
	assert.equal((await h.api("PATCH", `/api/cases/${caseNumber}/status`, { token: technician.token, body: { status: "Aprovado", destination: "reposicao" } })).status, 200);
	const detail = (await h.api("GET", `/api/cases/${caseNumber}`, { token: technician.token })).body.case;
	assert.equal(detail.warrantyDecision, "procedente");
	assert.equal(detail.warrantyDestination, "reposicao");
	assert.equal(detail.technicalOwnerId, technician.id);
});

test("editing records before/after and respects field-level permissions", async () => {
	const operator = await h.createUser("operator");
	const caseNumber = await h.createCase(operator.token, "Garantia");
	const edit = await h.api("PATCH", `/api/cases/${caseNumber}`, { token: operator.token, body: { client: "Novo Nome", trackingCode: "ABC", notes: "" } });
	assert.equal(edit.status, 200);
	assert.equal(edit.body.case.client, "Novo Nome");
	const event = edit.body.case.events.find((entry) => entry.type === "EDICAO");
	assert.equal(event.details.changes.client.before, "Cliente Teste");
	assert.equal(event.details.changes.client.after, "Novo Nome");
	assert.equal((await h.api("PATCH", `/api/cases/${caseNumber}`, { token: operator.token, body: { logisticsStatus: "Em transporte" } })).status, 403);
	const logistics = await h.createUser("logistics");
	assert.equal((await h.api("PATCH", `/api/cases/${caseNumber}`, { token: logistics.token, body: { logisticsStatus: "Em transporte" } })).status, 200);
});

test("duplicate origin document is blocked per type, case-insensitively (F3)", async () => {
	const operator = await h.createUser("operator");
	assert.equal((await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Garantia", { documentReference: "NF-123" }) })).status, 201);
	const duplicate = await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Garantia", { documentReference: "nf-123" }) });
	assert.equal(duplicate.status, 409);
	assert.equal(duplicate.body.code, "DUPLICATE_ORIGIN_DOCUMENT");
	assert.equal((await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Pedido de venda", { documentReference: "NF-123" }) })).status, 201, "outro tipo pode");
});

test("visibility: operators only see their cases; technicians and auditors see all but auditors cannot write", async () => {
	const a = await h.createUser("operator");
	const b = await h.createUser("operator");
	const technician = await h.createUser("technician");
	const auditor = await h.createUser("auditor");
	const caseA = await h.createCase(a.token);
	assert.equal((await h.api("GET", `/api/cases/${caseA}`, { token: b.token })).status, 404);
	assert.equal((await h.api("GET", `/api/cases/${caseA}`, { token: technician.token })).status, 200);
	assert.equal((await h.api("GET", `/api/cases/${caseA}`, { token: auditor.token })).status, 200);
	assert.equal((await h.api("GET", "/api/cases", { token: b.token })).body.total, 0);
	assert.equal((await h.api("GET", "/api/cases", { token: auditor.token })).body.total, 1);
	assert.equal((await h.api("POST", `/api/cases/${caseA}/comments`, { token: auditor.token, body: { body: "oi" } })).status, 403);
	assert.equal((await h.api("POST", "/api/cases", { token: auditor.token, body: h.basePayload() })).status, 403);
});

test("pagination, sorting and filters on the case list", async () => {
	const operator = await h.createUser("operator");
	for (const client of ["Beta", "Alfa", "Gama"]) await h.createCase(operator.token, "Garantia", { client });
	await h.createCase(operator.token, "Pedido de venda", { client: "Delta" });
	const sorted = await h.api("GET", "/api/cases?sort=client&direction=asc&pageSize=2&page=1", { token: operator.token });
	assert.equal(sorted.body.total, 4);
	assert.equal(sorted.body.totalPages, 2);
	assert.deepEqual(sorted.body.cases.map((item) => item.client), ["Alfa", "Beta"]);
	const page2 = await h.api("GET", "/api/cases?sort=client&direction=asc&pageSize=2&page=2", { token: operator.token });
	assert.deepEqual(page2.body.cases.map((item) => item.client), ["Delta", "Gama"]);
	const onlyOrders = await h.api("GET", "/api/cases?type=Pedido%20de%20venda", { token: operator.token });
	assert.equal(onlyOrders.body.total, 1);
	assert.equal((await h.api("GET", "/api/cases?client=alf", { token: operator.token })).body.total, 1);
	assert.equal((await h.api("GET", "/api/cases?client=%25", { token: operator.token })).body.total, 0, "curingas sao escapados");
	assert.equal((await h.api("GET", "/api/cases?sort=password", { token: operator.token })).status, 400);
});

test("SLA pauses while waiting for a document and resumes extending the deadline (F8)", async () => {
	const operator = await h.createUser("operator");
	const caseNumber = await h.createCase(operator.token, "Garantia");
	await h.api("PATCH", `/api/cases/${caseNumber}/status`, { token: operator.token, body: { status: "Em analise" } });
	const before = (await h.api("GET", `/api/cases/${caseNumber}`, { token: operator.token })).body.case;
	await h.api("PATCH", `/api/cases/${caseNumber}/status`, { token: operator.token, body: { status: "Aguardando documento" } });
	const paused = (await h.api("GET", `/api/cases/${caseNumber}`, { token: operator.token })).body.case;
	assert.equal(paused.sla, "paused");
	await h.database.query("UPDATE cases SET sla_paused_at = NOW() - INTERVAL '2 days' WHERE case_number = $1", [caseNumber]);
	await h.api("PATCH", `/api/cases/${caseNumber}/status`, { token: operator.token, body: { status: "Em analise" } });
	const resumed = (await h.api("GET", `/api/cases/${caseNumber}`, { token: operator.token })).body.case;
	assert.equal(resumed.slaPaused, false);
	const extendedDays = (new Date(resumed.dueAt) - new Date(before.dueAt)) / 86400000;
	assert.ok(extendedDays > 1.9 && extendedDays < 2.1, `prazo deveria ganhar ~2 dias, ganhou ${extendedDays}`);
	await h.database.query("UPDATE cases SET due_at = NOW() - INTERVAL '1 hour' WHERE case_number = $1", [caseNumber]);
	assert.equal((await h.api("GET", `/api/cases/${caseNumber}`, { token: operator.token })).body.case.sla, "overdue");
	const dashboard = await h.api("GET", "/api/dashboard/summary", { token: operator.token });
	assert.equal(dashboard.body.indicators.find((entry) => entry.label === "Processos atrasados").value, 1);
});

test("attachments: real upload, type sniffing, size limit, download and role-based reading (F4)", async () => {
	const operator = await h.createUser("operator");
	const logistics = await h.createUser("logistics");
	const technician = await h.createUser("technician");
	const caseNumber = await h.createCase(operator.token);
	const upload = (token, buffer, kind, name = "foto.png") => h.api("POST", `/api/cases/${caseNumber}/attachments/upload?kind=${kind}`, { token, raw: buffer, headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) } });

	const ok = await upload(operator.token, h.PNG, "foto");
	assert.equal(ok.status, 201);
	assert.equal(ok.body.attachment.mimeType, "image/png");
	assert.equal((await upload(operator.token, Buffer.from("MZ executable"), "foto", "virus.png")).status, 415, "tipo real, nao a extensao");
	assert.equal((await upload(operator.token, h.PNG, "laudo")).status, 403, "operador nao envia laudo");
	assert.equal((await upload(technician.token, h.PNG, "laudo", "laudo.png")).status, 201);

	const download = await h.api("GET", `/api/cases/${caseNumber}/attachments/${ok.body.attachment.id}/file`, { token: operator.token });
	assert.equal(download.status, 200);
	assert.equal(download.headers.get("content-type"), "image/png");
	assert.ok(Buffer.compare(download.body, h.PNG) === 0);

	const logisticsList = await h.api("GET", `/api/cases/${caseNumber}/attachments`, { token: await (async () => { await h.database.query("UPDATE cases SET assigned_to = $1", [logistics.id]); return logistics.token; })() });
	assert.deepEqual(logisticsList.body.attachments.map((entry) => entry.kind), ["foto"], "logistica nao le laudo");

	assert.equal((await h.api("POST", `/api/cases/${caseNumber}/attachments`, { token: operator.token, body: { fileName: "x", fileUrl: "javascript:alert(1)" } })).status, 400);
	assert.equal((await h.api("POST", `/api/cases/${caseNumber}/attachments`, { token: operator.token, body: { fileName: "Manual", fileUrl: "https://example.com/manual.pdf" } })).status, 201);
	assert.equal((await h.api("DELETE", `/api/cases/${caseNumber}/attachments/${ok.body.attachment.id}`, { token: operator.token })).status, 204);
	const detail = (await h.api("GET", `/api/cases/${caseNumber}`, { token: technician.token })).body.case;
	assert.equal(detail.attachments.length, 2);
});

test("archiving hides finished cases and physical deletion is blocked", async () => {
	const operator = await h.createUser("operator");
	const manager = await h.createUser("manager");
	const caseNumber = await h.createCase(operator.token);
	assert.equal((await h.api("POST", `/api/cases/${caseNumber}/archive`, { token: manager.token })).status, 422, "so finalizados");
	await h.api("PATCH", `/api/cases/${caseNumber}/status`, { token: operator.token, body: { status: "Cancelado", reason: "Duplicado" } });
	assert.equal((await h.api("POST", `/api/cases/${caseNumber}/archive`, { token: operator.token })).status, 403);
	assert.equal((await h.api("POST", `/api/cases/${caseNumber}/archive`, { token: manager.token })).status, 200);
	assert.equal((await h.api("GET", "/api/cases", { token: manager.token })).body.total, 0);
	assert.equal((await h.api("GET", "/api/cases?archived=true", { token: manager.token })).body.total, 1);
	await assert.rejects(h.database.query("DELETE FROM cases WHERE case_number = $1", [caseNumber]), /Exclusao fisica/);
});

test("creation is atomic: a failure leaves no orphan case, event or checklist", async () => {
	const operator = await h.createUser("operator");
	const response = await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Pedido de venda", { customerId: 99999 }) });
	assert.equal(response.status, 400);
	const { rows } = await h.database.query("SELECT (SELECT COUNT(*) FROM cases)::int AS cases, (SELECT COUNT(*) FROM case_events)::int AS events, (SELECT COUNT(*) FROM case_checklist_items)::int AS checklist, (SELECT COALESCE(SUM(last_value), 0) FROM case_sequences)::int AS sequence");
	assert.deepEqual(rows[0], { cases: 0, events: 0, checklist: 0, sequence: 0 });
});

test("order with multiple items stores items, totals and summary (F6)", async () => {
	const operator = await h.createUser("operator");
	const response = await h.api("POST", "/api/cases", { token: operator.token, body: { type: "Pedido de venda", client: "Oficina", product: "x", productCode: "x", quantity: 1, items: [
		{ productCode: "A1", description: "Valvula", quantity: 2, unitPrice: 10.5 },
		{ productCode: "B2", description: "Cilindro", quantity: 1, unitPrice: 100 }
	] } });
	assert.equal(response.status, 201);
	const detail = (await h.api("GET", `/api/cases/${response.body.case.id}`, { token: operator.token })).body.case;
	assert.equal(detail.items.length, 2);
	assert.equal(detail.totalValue, 121);
	assert.equal(detail.productCode, "A1");
	assert.equal(detail.quantity, 3);
});

test("customers and products registry with CPF/CNPJ validation (F3)", async () => {
	const operator = await h.createUser("operator");
	const manager = await h.createUser("manager");
	assert.equal((await h.api("POST", "/api/customers", { token: operator.token, body: { name: "Invalido", document: "123" } })).status, 400);
	const created = await h.api("POST", "/api/customers", { token: operator.token, body: { name: "Auto Viacao ABC", document: "11.222.333/0001-81" } });
	assert.equal(created.status, 201);
	assert.equal(created.body.customer.document, "11222333000181");
	assert.equal((await h.api("POST", "/api/customers", { token: operator.token, body: { name: "Outro", document: "11222333000181" } })).status, 409);
	assert.equal((await h.api("PATCH", `/api/customers/${created.body.customer.id}`, { token: operator.token, body: { name: "x" } })).status, 403);
	assert.equal((await h.api("PATCH", `/api/customers/${created.body.customer.id}`, { token: manager.token, body: { name: "Auto Viacao ABC SA" } })).status, 200);
	const search = await h.api("GET", "/api/customers?q=viacao", { token: operator.token });
	assert.equal(search.body.customers.length, 1);
	assert.equal((await h.api("GET", "/api/customers?q=11222", { token: operator.token })).body.customers.length, 1);

	assert.equal((await h.api("POST", "/api/products", { token: operator.token, body: { code: "CP-01", description: "Compressor" } })).status, 201);
	assert.equal((await h.api("POST", "/api/products", { token: operator.token, body: { code: "CP-01", description: "Outro" } })).status, 409);
	const linked = await h.api("POST", "/api/cases", { token: operator.token, body: h.basePayload("Garantia", { clientDocument: "11222333000181" }) });
	const detail = (await h.api("GET", `/api/cases/${linked.body.case.id}`, { token: operator.token })).body.case;
	assert.equal(detail.customerId, created.body.customer.id);
	assert.ok(detail.productId);
});

test("notifications, bulk assignment and SLA alerts job", async () => {
	const manager = await h.createUser("manager");
	const operator = await h.createUser("operator");
	const caseNumber = await h.createCase(manager.token);
	const assign = await h.api("POST", "/api/cases/bulk/assign", { token: manager.token, body: { caseNumbers: [caseNumber, "NAO-EXISTE"], assignedTo: operator.id } });
	assert.equal(assign.body.assigned, 1);
	const list = await h.api("GET", "/api/notifications", { token: operator.token });
	assert.equal(list.body.unread, 1);
	assert.equal(list.body.notifications[0].kind, "CASE_ASSIGNED");
	assert.equal(list.body.notifications[0].caseNumber, caseNumber);
	await h.api("PATCH", `/api/notifications/${list.body.notifications[0].id}/read`, { token: operator.token });
	assert.equal((await h.api("GET", "/api/notifications", { token: operator.token })).body.unread, 0);

	await h.database.query("UPDATE cases SET due_at = NOW() - INTERVAL '1 hour' WHERE case_number = $1", [caseNumber]);
	const { runSlaAlerts } = require("../services/sla");
	assert.equal(await runSlaAlerts(), 1);
	assert.equal(await runSlaAlerts(), 0, "nao notifica duas vezes");
	assert.equal((await h.api("GET", "/api/notifications?unread=true", { token: operator.token })).body.notifications[0].kind, "SLA_OVERDUE");
});

test("settings persist and exports (csv, xlsx, pdf) work with filters", async () => {
	const manager = await h.createUser("manager");
	const operator = await h.createUser("operator");
	assert.equal((await h.api("PUT", "/api/settings/require_documents", { token: operator.token, body: { value: false } })).status, 403);
	assert.equal((await h.api("PUT", "/api/settings/require_documents", { token: manager.token, body: { value: false } })).status, 200);
	assert.equal((await h.api("GET", "/api/settings", { token: operator.token })).body.settings.require_documents, false);
	await h.createCase(operator.token, "Garantia", { client: "=HYPERLINK(\"x\")" });
	const csv = await h.api("GET", "/api/reports/export.csv", { token: operator.token });
	assert.equal(csv.status, 200);
	assert.match(csv.body, /'=HYPERLINK/, "formulas neutralizadas");
	const xlsx = await h.api("GET", "/api/reports/export.xlsx", { token: operator.token });
	assert.equal(xlsx.status, 200);
	assert.equal(xlsx.body.subarray(0, 2).toString(), "PK");
	const pdf = await h.api("GET", "/api/reports/export.pdf?type=Garantia", { token: operator.token });
	assert.equal(pdf.status, 200);
	assert.equal(pdf.body.subarray(0, 5).toString(), "%PDF-");
	const byCustomer = await h.api("GET", "/api/reports/by-customer", { token: manager.token });
	assert.equal(byCustomer.body.rows.length, 1);
	const advanced = await h.api("GET", "/api/reports/advanced", { token: manager.token });
	assert.equal(advanced.status, 200);
});

test("unknown API routes answer 404 with a request id", async () => {
	const operator = await h.createUser("operator");
	const response = await h.api("GET", "/api/nao-existe", { token: operator.token });
	assert.equal(response.status, 404);
	assert.ok(response.body.requestId);
	assert.ok(response.headers.get("x-request-id"));
});

test("serial/lot filter finds a part across orders, exchanges and warranties (F16) and metrics are token-protected", async () => {
	const operator = await h.createUser("operator");
	await h.createCase(operator.token, "Garantia", { serialNumber: "SN-777" });
	await h.createCase(operator.token, "Base de troca", { lotNumber: "LOTE-SN-777-B" });
	await h.createCase(operator.token, "Pedido de venda", { serialNumber: "OUTRO" });
	const found = await h.api("GET", "/api/cases?serial=SN-777", { token: operator.token });
	assert.equal(found.body.total, 2);
	assert.equal((await h.api("GET", "/api/search?q=SN-777", { token: operator.token })).body.cases.length, 2);
	assert.equal((await h.api("GET", "/api/metrics")).status, 404, "sem METRICS_TOKEN a rota nao existe");
	process.env.METRICS_TOKEN = "secret-token";
	try {
		assert.equal((await h.api("GET", "/api/metrics")).status, 401);
		const metrics = await h.api("GET", "/api/metrics", { headers: { Authorization: "Bearer secret-token" } });
		assert.equal(metrics.status, 200);
		assert.match(metrics.body, /pp_http_requests_total/);
		assert.match(metrics.body, /pp_cases_open 3/);
	} finally { delete process.env.METRICS_TOKEN; }
});
