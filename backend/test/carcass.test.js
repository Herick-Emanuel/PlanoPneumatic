// Controle de carcacas: debito, devolucao (aproveitavel abate, refugada nao), ajuste, estorno, vencidas,
// saldo por cliente e por representante e debito automatico pelas NF-e de saida do Omie.
const assert = require("node:assert/strict");
const { before, after, beforeEach, test } = require("node:test");
const h = require("./helpers");
const carcass = require("../services/carcass");
const mirror = require("../services/omieMirror");
const settings = require("../services/settings");

before(h.setup);
after(h.teardown);
beforeEach(async () => {
	await h.resetDatabase();
	await h.database.query("TRUNCATE carcass_entries, representatives, omie_invoices RESTART IDENTITY CASCADE");
});

async function scenario() {
	const manager = await h.createUser("manager");
	const operator = await h.createUser("operator");
	const rep = (await h.api("POST", "/api/representatives", { token: manager.token, body: { name: "Carlos Rep", code: "R01" } })).body.representative;
	const other = (await h.api("POST", "/api/representatives", { token: manager.token, body: { name: "Bia Rep" } })).body.representative;
	const customer = (await h.api("POST", "/api/customers", { token: manager.token, body: { name: "Transportes Alfa", representativeId: rep.id } })).body
		.customer;
	const second = (await h.api("POST", "/api/customers", { token: manager.token, body: { name: "Oficina Beta", representativeId: other.id } })).body.customer;
	return { manager, operator, rep, other, customer, second };
}
const entry = (token, body) => h.api("POST", "/api/carcass/entries", { token, body });

test("saldo: debito, devolucao aproveitavel abate, refugada nao abate, ajuste e estorno", async () => {
	const { manager, operator, rep, customer } = await scenario();
	assert.equal(customer.representativeName, "Carlos Rep");
	const debit = await entry(operator.token, { kind: "debit", customerId: customer.id, productCode: "cp-10", quantity: 5, document: "NF 100" });
	assert.equal(debit.status, 201);
	assert.equal(debit.body.entry.representativeId, rep.id, "herda o representante do cliente");
	assert.equal(debit.body.entry.productCode, "CP-10");
	assert.ok(debit.body.entry.dueDate, "prazo padrao preenchido");

	assert.equal(
		(await entry(operator.token, { kind: "return", customerId: customer.id, productCode: "CP-10", quantity: 2 })).status,
		400,
		"devolucao exige condicao"
	);
	await entry(operator.token, { kind: "return", customerId: customer.id, productCode: "CP-10", quantity: 2, condition: "aproveitavel" });
	await entry(operator.token, { kind: "return", customerId: customer.id, productCode: "CP-10", quantity: 1, condition: "refugada" });
	assert.equal(
		(await entry(operator.token, { kind: "adjustment", customerId: customer.id, productCode: "CP-10", quantity: -1 })).status,
		400,
		"ajuste exige motivo"
	);
	const adjustment = await entry(operator.token, {
		kind: "adjustment",
		customerId: customer.id,
		productCode: "CP-10",
		quantity: -1,
		notes: "Contagem do estoque"
	});

	let summary = (await h.api("GET", "/api/carcass/summary", { token: operator.token })).body;
	assert.equal(summary.rows.length, 1);
	assert.deepEqual(
		[summary.rows[0].debited, summary.rows[0].returned, summary.rows[0].refused, summary.rows[0].outstanding],
		[5, 3, 1, 2],
		"5 devidas - 2 aproveitaveis - 1 ajuste = 2 (refugada registrada sem abater)"
	);
	assert.equal(summary.totals.refusedThisMonth, 1);

	// Estorno: so gerente/administrador, com motivo; o ajuste deixa de valer.
	assert.equal(
		(await h.api("POST", `/api/carcass/entries/${adjustment.body.entry.id}/reverse`, { token: operator.token, body: { reason: "erro" } })).status,
		403
	);
	const reversed = await h.api("POST", `/api/carcass/entries/${adjustment.body.entry.id}/reverse`, {
		token: manager.token,
		body: { reason: "Lancado em dobro" }
	});
	assert.ok(reversed.body.entry.reversedAt);
	summary = (await h.api("GET", "/api/carcass/summary", { token: operator.token })).body;
	assert.equal(summary.rows[0].outstanding, 3);
	const ledger = (await h.api("GET", `/api/carcass/entries?customerId=${customer.id}`, { token: operator.token })).body;
	assert.equal(ledger.total, 4, "nada e apagado");
	const audited = await h.database.query("SELECT COUNT(*)::int AS total FROM audit_log WHERE entity_type = 'carcass'");
	assert.equal(audited.rows[0].total, 5);
});

test("vencidas: devolucoes quitam primeiro os debitos mais antigos; saldo por representante", async () => {
	const { operator, rep, other, customer, second } = await scenario();
	await entry(operator.token, { kind: "debit", customerId: customer.id, productCode: "CP-10", quantity: 3, entryDate: "2026-01-01", dueDate: "2026-01-31" });
	await entry(operator.token, { kind: "debit", customerId: customer.id, productCode: "CP-10", quantity: 4, entryDate: "2099-01-01", dueDate: "2099-01-31" });
	await entry(operator.token, { kind: "return", customerId: customer.id, productCode: "CP-10", quantity: 1, condition: "aproveitavel" });
	await entry(operator.token, { kind: "debit", customerId: second.id, productCode: "VL-1", quantity: 2, entryDate: "2026-01-01", dueDate: "2026-01-10" });
	// Debito lancado para outro representante (troca so neste lancamento).
	await entry(operator.token, { kind: "debit", customerId: second.id, representativeId: rep.id, productCode: "VL-2", quantity: 1, dueDate: "2099-01-01" });

	const byCustomer = (await h.api("GET", "/api/carcass/summary", { token: operator.token })).body;
	const alfa = byCustomer.rows.find((row) => row.name === "Transportes Alfa");
	assert.equal(alfa.outstanding, 6);
	assert.equal(alfa.overdue, 2, "3 vencidas - 1 devolvida");
	assert.equal(alfa.nextDue, "2026-01-31");
	assert.equal(byCustomer.totals.overdue, 4);
	assert.equal(byCustomer.rows[0].name, "Transportes Alfa", "mais vencidas primeiro");

	const onlyOverdue = (await h.api("GET", "/api/carcass/summary?overdue=true", { token: operator.token })).body;
	assert.equal(onlyOverdue.rows.length, 2);

	const byRep = (await h.api("GET", "/api/carcass/summary?groupBy=representative", { token: operator.token })).body;
	const carlos = byRep.rows.find((row) => row.name === "Carlos Rep");
	const bia = byRep.rows.find((row) => row.name === "Bia Rep");
	assert.equal(carlos.outstanding, 7, "Alfa (6) + VL-2 da Beta lancado para o Carlos (1)");
	assert.equal(carlos.customerCount, 2);
	assert.equal(bia.outstanding, 2);
	assert.equal(bia.representativeId, other.id);

	const auditor = await h.createUser("auditor");
	assert.equal((await h.api("GET", "/api/carcass/summary", { token: auditor.token })).status, 200, "auditor consulta");
	assert.equal((await entry(auditor.token, { kind: "debit", customerId: customer.id, productCode: "X", quantity: 1 })).status, 403, "auditor nao lanca");
});

test("Omie: NF de saida com peca remanufaturada gera debito uma vez; nota cancelada estorna", async () => {
	const { manager, customer } = await scenario();
	await h.database.query("UPDATE customers SET omie_code = 77 WHERE id = $1", [customer.id]);
	await h.api("POST", "/api/products", { token: manager.token, body: { code: "REM-1", description: "Compressor reman", remanufactured: true } });
	await h.api("POST", "/api/products", { token: manager.token, body: { code: "NOVA-1", description: "Peca nova" } });
	await settings.set("carcass_omie_start", "2026-11-01", null);
	await settings.set("carcass_due_days", 15, null);
	const nf = (extra = {}) => ({
		ide: { nNF: "000900", serie: "1", dEmi: "20/11/2026", tpNF: "1", finNFe: "1", ...extra },
		compl: { nIdNF: 900 },
		nfDestInt: { nCodCli: 77, cRazao: "Transportes Alfa" },
		det: [
			{ prod: { cProd: "REM-1", xProd: "Compressor reman", qCom: 2 } },
			{ prod: { cProd: "REM-1", xProd: "Compressor reman", qCom: 1 } },
			{ prod: { cProd: "NOVA-1", xProd: "Peca nova", qCom: 5 } }
		]
	});
	await mirror.upsertInvoice(nf());
	await mirror.upsertInvoice(nf()); // reprocessar a mesma nota (webhook + sincronizacao) nao duplica
	let { rows } = await h.database.query(
		"SELECT product_code, quantity, due_date::text, entry_date::text, document, representative_id, reversed_at FROM carcass_entries"
	);
	assert.equal(rows.length, 1);
	assert.deepEqual(
		{ ...rows[0], reversed_at: undefined },
		{
			product_code: "REM-1",
			quantity: 3,
			due_date: "2026-12-05",
			entry_date: "2026-11-20",
			document: "NF 000900/1",
			representative_id: customer.representativeId,
			reversed_at: undefined
		}
	);

	// Antes da data de inicio, devolucao (finNFe 4) e nota de entrada nao geram debito.
	await mirror.upsertInvoice({ ...nf({ nNF: "000800", dEmi: "20/10/2026" }), compl: { nIdNF: 800 } });
	await mirror.upsertInvoice({ ...nf({ nNF: "000801", finNFe: "4" }), compl: { nIdNF: 801 } });
	await mirror.upsertInvoice({ ...nf({ nNF: "000802", tpNF: "0" }), compl: { nIdNF: 802 } });
	assert.equal((await h.database.query("SELECT COUNT(*)::int AS total FROM carcass_entries")).rows[0].total, 1);

	await mirror.upsertInvoice(nf({ dCan: "21/11/2026" }));
	({ rows } = await h.database.query("SELECT reversed_at, reversal_reason FROM carcass_entries"));
	assert.ok(rows[0].reversed_at);
	assert.match(rows[0].reversal_reason, /cancelada/);
});

test("configuracao do prazo: so gerente/administrador; aviso diario de vencidas para gestores", async () => {
	const { manager, operator, customer } = await scenario();
	assert.equal((await h.api("PUT", "/api/carcass/config", { token: operator.token, body: { dueDays: 10, omieStart: null } })).status, 403);
	assert.equal((await h.api("PUT", "/api/carcass/config", { token: manager.token, body: { dueDays: 45, omieStart: "" } })).status, 200);
	const config = (await h.api("GET", "/api/carcass/config", { token: operator.token })).body;
	assert.deepEqual([config.dueDays, config.omieStart, config.canEdit], [45, null, false]);
	const debit = await entry(operator.token, { kind: "debit", customerId: customer.id, productCode: "CP-1", quantity: 1, entryDate: "2026-01-01" });
	assert.equal(debit.body.entry.dueDate, "2026-02-15");

	await entry(operator.token, { kind: "debit", customerId: customer.id, productCode: "CP-2", quantity: 2, entryDate: "2026-11-01", dueDate: "2026-11-02" });
	await h.database.query("DELETE FROM app_settings WHERE key = 'carcass_last_notified'");
	settings.invalidate();
	const notified = await carcass.notifyOverdue();
	assert.ok(notified >= 1);
	const { rows } = await h.database.query("SELECT message FROM notifications WHERE user_id = $1 AND kind = 'CARCASS_OVERDUE'", [manager.id]);
	assert.equal(rows.length, 1);
	assert.match(rows[0].message, /Transportes Alfa/);
	assert.equal(await carcass.notifyOverdue(), 0, "uma vez por dia");
});
