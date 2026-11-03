const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isValidCpf, isValidCnpj, isValidDocument, formatDocument, onlyDigits } = require("../validators/document");
const { allowedTransitions, isTransitionValid, validateTransition } = require("../domain/workflow");
const { can } = require("../domain/permissions");
const { detectMime } = require("../services/attachments");
const { safeCell } = require("../services/exports");

test("CPF and CNPJ check digits", () => {
	assert.ok(isValidCpf("52998224725"));
	assert.ok(!isValidCpf("52998224724"));
	assert.ok(!isValidCpf("11111111111"));
	assert.ok(isValidCnpj("11222333000181"));
	assert.ok(!isValidCnpj("11222333000182"));
	assert.ok(isValidDocument("529.982.247-25"));
	assert.ok(!isValidDocument("abc"));
	assert.equal(formatDocument("52998224725"), "529.982.247-25");
	assert.equal(formatDocument("11222333000181"), "11.222.333/0001-81");
	assert.equal(onlyDigits("11.222.333/0001-81"), "11222333000181");
});

test("every type has a path from Criado to a final status", () => {
	for (const type of ["Pedido de venda", "Base de troca", "Garantia"]) {
		const seen = new Set(["Criado"]);
		const queue = ["Criado"];
		while (queue.length) {
			const current = queue.shift();
			for (const next of require("../domain/workflow").nextStatuses(type, current)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
		}
		assert.ok(seen.has("Encerrado"), `${type} deve poder ser encerrado`);
		assert.ok(seen.has("Cancelado"));
	}
	assert.ok(!isTransitionValid("Pedido de venda", "Em analise", "Improcedente"));
	assert.ok(isTransitionValid("Garantia", "Em analise", "Improcedente"));
});

test("permission matrix for the new roles", () => {
	const user = (role) => ({ role });
	assert.ok(can(user("technician"), "cases.technical"));
	assert.ok(!can(user("supervisor"), "cases.decide"));
	assert.ok(can(user("supervisor"), "cases.assign"));
	assert.ok(!can(user("auditor"), "cases.edit"));
	assert.ok(can(user("auditor"), "users.audit.view"));
	assert.ok(can(user("logistics"), "cases.logistics"));
	assert.ok(!can(user("operator"), "cases.decide"));
});

test("allowedTransitions hides decision statuses from operators and adds reopen for managers", () => {
	const item = { type: "Garantia", status: "Em analise" };
	assert.deepEqual(allowedTransitions({ role: "operator" }, item), ["Aguardando documento", "Cancelado"]);
	assert.ok(allowedTransitions({ role: "technician" }, item).includes("Improcedente"));
	assert.deepEqual(allowedTransitions({ role: "manager" }, { type: "Garantia", status: "Cancelado" }), ["Em analise"]);
	assert.deepEqual(allowedTransitions({ role: "auditor" }, item), []);
	assert.equal(validateTransition({ role: "manager" }, item, "Concluido", { checklist: [], attachmentCount: 0 }).code, "INVALID_TRANSITION");
});

test("file type sniffing and spreadsheet formula neutralization", () => {
	assert.equal(detectMime(Buffer.from("%PDF-1.7 ...")), "application/pdf");
	assert.equal(detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	assert.equal(detectMime(Buffer.from("<html>")), null);
	assert.equal(safeCell("=1+1"), "'=1+1");
	assert.equal(safeCell("normal"), "normal");
});
