// Espelho local de pedidos de venda e notas fiscais do Omie.
// A tela "Pedidos e notas do Omie" le daqui (rapido e sem depender do ERP). O espelho e alimentado por:
//  - webhook do Omie (tempo real: o Omie avisa quando um pedido/nota muda);
//  - sincronizacao incremental agendada (pega o que mudou desde a ultima, cobre avisos perdidos);
//  - primeira carga completa, na primeira sincronizacao.
const { database } = require("../db");
const { isValidDocument, onlyDigits } = require("../validators/document");
const { logEvent } = require("../middleware/errors");

const PAGE_SIZE = 50;

const clean = (value, max) => {
	const text = String(value ?? "").trim();
	return text ? text.slice(0, max) : "";
};
const validDocument = (value) => {
	const digits = onlyDigits(value);
	return digits && isValidDocument(digits) ? digits : "";
};
// "DD/MM/AAAA" (Omie) -> "AAAA-MM-DD" (banco); invalido -> null.
const isoFromOmie = (value) => {
	const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || "").trim());
	return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
};

function mapOrder(order) {
	const header = order.cabecalho || {};
	const info = order.infoCadastro || {};
	const items = (order.det || [])
		.map((entry) => ({
			productCode: clean(entry.produto?.codigo, 80),
			description: clean(entry.produto?.descricao, 180),
			quantity: Math.max(1, Math.round(Number(entry.produto?.quantidade) || 1)),
			unitPrice: Number(entry.produto?.valor_unitario) || 0
		}))
		.filter((item) => item.productCode && item.description);
	return {
		ref: String(header.codigo_pedido),
		omieOrderCode: Number(header.codigo_pedido) || null,
		number: String(header.numero_pedido || ""),
		date: info.dInc || header.data_previsao || "",
		customerCode: Number(header.codigo_cliente) || null,
		stage: String(header.etapa || ""),
		invoiced: info.faturado === "S",
		cancelled: info.cancelado === "S",
		total: Number(order.total_pedido?.valor_total_pedido) || items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
		items
	};
}

function mapInvoice(invoice) {
	const ide = invoice.ide || {};
	const items = (invoice.det || [])
		.map((entry) => ({
			productCode: clean(entry.prod?.cProd, 80),
			description: clean(entry.prod?.xProd, 180),
			quantity: Math.max(1, Math.round(Number(entry.prod?.qCom) || 1)),
			unitPrice: Number(entry.prod?.vUnCom) || 0
		}))
		.filter((item) => item.productCode && item.description);
	return {
		ref: String(ide.nNF || "").replace(/^0+/, ""),
		omieId: Number(invoice.compl?.nIdNF) || null,
		number: String(ide.nNF || ""),
		series: String(ide.serie || ""),
		date: ide.dEmi || "",
		type: ide.tpNF === "0" ? "entrada" : "saida",
		purpose: String(ide.finNFe || ""),
		isReturn: String(ide.finNFe) === "4",
		cancelled: Boolean(clean(ide.dCan, 20)),
		omieOrderCode: Number(invoice.compl?.nIdPedido) || null,
		customerCode: Number(invoice.nfDestInt?.nCodCli) || null,
		customerName: clean(invoice.nfDestInt?.cRazao, 180),
		customerDocument: validDocument(invoice.nfDestInt?.cnpj_cpf),
		total: Number(invoice.total?.ICMSTot?.vNF) || 0,
		items
	};
}

async function upsertOrder(raw) {
	const order = mapOrder(raw);
	if (!order.omieOrderCode) return "skipped";
	const { rows } = await database.query(
		`INSERT INTO omie_orders (omie_code, number, order_date, customer_code, invoiced, cancelled, total, data, synced_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
		 ON CONFLICT (omie_code) DO UPDATE SET number = EXCLUDED.number, order_date = EXCLUDED.order_date, customer_code = EXCLUDED.customer_code,
		   invoiced = EXCLUDED.invoiced, cancelled = EXCLUDED.cancelled, total = EXCLUDED.total, data = EXCLUDED.data, synced_at = NOW()
		 RETURNING (xmax = 0) AS inserted`,
		[order.omieOrderCode, order.number, isoFromOmie(order.date), order.customerCode, order.invoiced, order.cancelled, order.total, order]
	);
	return rows[0].inserted ? "created" : "updated";
}

async function upsertInvoice(raw) {
	const invoice = mapInvoice(raw);
	if (!invoice.ref) return "skipped";
	const key = invoice.omieId ? `id:${invoice.omieId}` : `${invoice.type}:${invoice.series}:${invoice.ref}`;
	const { rows } = await database.query(
		`INSERT INTO omie_invoices (mirror_key, ref, number, series, issue_date, nf_type, customer_code, total, data, synced_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
		 ON CONFLICT (mirror_key) DO UPDATE SET ref = EXCLUDED.ref, number = EXCLUDED.number, series = EXCLUDED.series, issue_date = EXCLUDED.issue_date,
		   nf_type = EXCLUDED.nf_type, customer_code = EXCLUDED.customer_code, total = EXCLUDED.total, data = EXCLUDED.data, synced_at = NOW()
		 RETURNING (xmax = 0) AS inserted`,
		[key, invoice.ref, invoice.number, invoice.series, isoFromOmie(invoice.date), invoice.type, invoice.customerCode, invoice.total, invoice]
	);
	// NF de saida com peca remanufaturada gera o debito de carcaca (ou estorna, se a nota foi cancelada).
	await require("./carcass")
		.fromInvoice(invoice, key)
		.catch((error) => logEvent("carcass_from_invoice_error", { key, error: error.message }));
	return rows[0].inserted ? "created" : "updated";
}

// Completa nome e documento do cliente pelo cadastro sincronizado (sem chamar o Omie).
async function attachCustomers(rows) {
	const codes = [...new Set(rows.map((row) => row.customerCode).filter(Boolean))];
	if (!codes.length) return rows;
	const { rows: customers } = await database.query("SELECT omie_code, name, document FROM customers WHERE omie_code = ANY($1::bigint[])", [codes]);
	const byCode = new Map(customers.map((customer) => [Number(customer.omie_code), customer]));
	return rows.map((row) => {
		const local = byCode.get(row.customerCode);
		return { ...row, customerName: row.customerName || local?.name || "", customerDocument: row.customerDocument || local?.document || "" };
	});
}

// Marca o que ja virou processo, para a tela nao deixar importar duas vezes.
async function attachExisting(rows, kind) {
	if (!rows.length) return rows;
	const column = kind === "orders" ? "omie_order_code::text" : "ltrim(omie_invoice_number, '0')";
	const { rows: found } = await database.query(`SELECT ${column} AS ref, case_number FROM cases WHERE ${column} = ANY($1::text[])`, [
		rows.map((row) => row.ref)
	]);
	const byRef = new Map();
	for (const item of found) byRef.set(item.ref, [...(byRef.get(item.ref) || []), item.case_number]);
	return rows.map((row) => ({ ...row, cases: byRef.get(row.ref) || [] }));
}

const TABLES = {
	orders: { table: "omie_orders", date: "order_date", order: "order_date DESC NULLS LAST, omie_code DESC" },
	invoices: { table: "omie_invoices", date: "issue_date", order: "issue_date DESC NULLS LAST, number DESC" }
};

// Lista do espelho: mais recentes primeiro, pagina 1 = mais novos.
async function list(kind, { from, to, page = 1, type, q } = {}) {
	const spec = TABLES[kind];
	const values = [];
	const clauses = ["TRUE"];
	const add = (sql, value) => {
		values.push(value);
		clauses.push(sql.replace("$V", `$${values.length}`));
	};
	if (from) add(`${spec.date} >= $V::date`, from);
	if (to) add(`${spec.date} <= $V::date`, to);
	if (kind === "invoices" && (type === "entrada" || type === "saida")) add("nf_type = $V", type);
	if (q) add("(number ILIKE $V OR data->>'customerName' ILIKE $V)", `%${String(q).replace(/[\\%_]/g, "\\$&")}%`);
	const where = clauses.join(" AND ");
	const [{ rows: count }, { rows }] = await Promise.all([
		database.query(`SELECT COUNT(*)::int AS total FROM ${spec.table} WHERE ${where}`, values),
		database.query(
			`SELECT data FROM ${spec.table} WHERE ${where} ORDER BY ${spec.order} LIMIT ${PAGE_SIZE} OFFSET ${(Math.max(1, page) - 1) * PAGE_SIZE}`,
			values
		)
	]);
	const total = count[0].total;
	const records = await attachExisting(await attachCustomers(rows.map((row) => row.data)), kind);
	return { [kind]: records, page: Math.max(1, page), totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total };
}

async function findOrder(ref) {
	const { rows } = await database.query("SELECT data FROM omie_orders WHERE omie_code = $1", [Number(ref) || 0]);
	return rows[0] ? (await attachCustomers([rows[0].data]))[0] : null;
}

async function findInvoice(ref) {
	const { rows } = await database.query("SELECT data FROM omie_invoices WHERE ref = $1 ORDER BY synced_at DESC LIMIT 1", [String(ref).replace(/^0+/, "")]);
	return rows[0] ? (await attachCustomers([rows[0].data]))[0] : null;
}

// Situacao do espelho para a tela (contagens, ultima sincronizacao e ultimo aviso do Omie).
async function mirrorStatus() {
	const { rows } = await database.query(`SELECT
		(SELECT COUNT(*)::int FROM omie_orders) AS orders,
		(SELECT COUNT(*)::int FROM omie_invoices) AS invoices,
		(SELECT MAX(synced_at) FROM omie_orders) AS orders_changed,
		(SELECT MAX(synced_at) FROM omie_invoices) AS invoices_changed,
		(SELECT MAX(started_at) FROM omie_sync_runs WHERE kind = 'orders' AND status = 'success') AS orders_synced,
		(SELECT MAX(started_at) FROM omie_sync_runs WHERE kind = 'invoices' AND status = 'success') AS invoices_synced,
		(SELECT COUNT(*)::int FROM omie_sync_runs WHERE kind IN ('orders', 'invoices') AND status = 'running' AND started_at > NOW() - INTERVAL '30 minutes') AS running,
		(SELECT MAX(received_at) FROM omie_webhook_events) AS webhook_at`);
	const row = rows[0];
	return {
		orders: { count: row.orders, lastChangeAt: row.orders_changed, lastSyncAt: row.orders_synced },
		invoices: { count: row.invoices, lastChangeAt: row.invoices_changed, lastSyncAt: row.invoices_synced },
		syncing: row.running > 0,
		lastWebhookAt: row.webhook_at
	};
}

module.exports = {
	mapOrder,
	mapInvoice,
	upsertOrder,
	upsertInvoice,
	attachCustomers,
	attachExisting,
	list,
	findOrder,
	findInvoice,
	mirrorStatus,
	isoFromOmie,
	PAGE_SIZE
};
