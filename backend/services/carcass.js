// Controle de carcacas (base de troca): quem recebe peca remanufaturada fica devendo a carcaca.
// Livro de lancamentos (carcass_entries) -> saldo por cliente, por representante e por codigo de peca.
// Regras:
//  - debito: saida de peca remanufaturada (manual ou NF-e de saida do Omie com peca marcada);
//  - devolucao aproveitavel abate o saldo; refugada fica registrada e NAO abate;
//  - ajuste: correcao com sinal; estorno anula um lancamento (nada e apagado);
//  - vencidas: debitos com prazo passado ainda nao cobertos pelas devolucoes (as devolucoes quitam
//    primeiro os debitos mais antigos).
const { z } = require("zod");
const { database } = require("../db");
const { AppError, logEvent } = require("../middleware/errors");
const { audit } = require("./audit");
const settings = require("./settings");
const notifications = require("./notifications");
const { likeTerm } = require("./caseFilters");

const TODAY_SQL = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

async function dueDays() {
	const value = Number(await settings.get("carcass_due_days", 30));
	return Number.isInteger(value) && value > 0 ? value : 30;
}

const addDays = (isoDate, days) => {
	const date = new Date(`${isoDate}T12:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
};
const todayIso = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- lancamentos
const optionalText = (max) =>
	z
		.string()
		.trim()
		.max(max)
		.optional()
		.transform((value) => value || undefined);
const isoDate = z
	.string()
	.regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "Data invalida.")
	.optional()
	.or(z.literal("").transform(() => undefined));

const entrySchema = z
	.object({
		kind: z.enum(["debit", "return", "adjustment"]),
		customerId: z.coerce.number().int().positive({ error: "Escolha o cliente." }),
		representativeId: z.coerce.number().int().positive().nullish(),
		productCode: z.string().trim().min(1, "Informe o codigo da peca.").max(80),
		productDescription: optionalText(180),
		quantity: z.coerce.number().int().min(-10000).max(10000),
		condition: z.enum(["aproveitavel", "refugada"]).optional(),
		entryDate: isoDate,
		dueDate: isoDate,
		document: optionalText(120),
		notes: optionalText(1000)
	})
	.superRefine((data, context) => {
		const issue = (message, path) => context.addIssue({ code: "custom", message, path: [path] });
		if (data.quantity === 0) issue("A quantidade nao pode ser zero.", "quantity");
		if (data.kind !== "adjustment" && data.quantity < 0) issue("Use quantidade positiva (para corrigir, use ajuste).", "quantity");
		if (data.kind === "return" && !data.condition) issue("Informe a condicao da carcaca recebida.", "condition");
		if (data.kind === "adjustment" && !data.notes) issue("Explique o motivo do ajuste.", "notes");
	});

async function customerById(id) {
	const { rows } = await database.query("SELECT id, name, representative_id FROM customers WHERE id = $1", [id]);
	if (!rows[0]) throw new AppError(404, "Cliente nao encontrado.", "NOT_FOUND");
	return rows[0];
}

async function createEntry(user, body) {
	const data = entrySchema.parse(body);
	const customer = await customerById(data.customerId);
	const representativeId = data.representativeId === undefined ? customer.representative_id : data.representativeId;
	const { rows: product } = await database.query("SELECT description FROM products WHERE lower(code) = lower($1) LIMIT 1", [data.productCode]);
	const entryDate = data.entryDate || todayIso();
	const dueDate = data.kind === "debit" ? data.dueDate || addDays(entryDate, await dueDays()) : null;
	const { rows } = await database.query(
		`INSERT INTO carcass_entries (kind, customer_id, customer_name, representative_id, product_code, product_description, quantity, condition, due_date, entry_date, document, notes, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
		[
			data.kind,
			customer.id,
			customer.name,
			representativeId || null,
			data.productCode.toUpperCase(),
			data.productDescription || product[0]?.description || null,
			data.quantity,
			data.kind === "return" ? data.condition : null,
			dueDate,
			entryDate,
			data.document || null,
			data.notes || null,
			user.id
		]
	);
	await audit("Lançamento de carcaça", {
		actorId: user.id,
		entityType: "carcass",
		entityId: rows[0].id,
		details: { kind: data.kind, customer: customer.name, productCode: data.productCode, quantity: data.quantity, condition: data.condition || null }
	});
	return getEntry(rows[0].id);
}

async function reverseEntry(user, id, reason) {
	const text = String(reason || "").trim();
	if (text.length < 3) throw new AppError(400, "Informe o motivo do estorno.", "VALIDATION_ERROR");
	const { rows } = await database.query(
		"UPDATE carcass_entries SET reversed_at = NOW(), reversed_by = $2, reversal_reason = $3 WHERE id = $1 AND reversed_at IS NULL RETURNING id",
		[id, user.id, text.slice(0, 240)]
	);
	if (!rows[0]) throw new AppError(404, "Lancamento nao encontrado ou ja estornado.", "NOT_FOUND");
	await audit("Estorno de lançamento de carcaça", { actorId: user.id, entityType: "carcass", entityId: id, details: { reason: text } });
	return getEntry(id);
}

const ENTRY_FIELDS = `e.id, e.kind, e.customer_id AS "customerId", e.customer_name AS "customerName", e.representative_id AS "representativeId",
	r.name AS "representativeName", e.product_code AS "productCode", e.product_description AS "productDescription", e.quantity, e.condition,
	e.due_date::text AS "dueDate", e.entry_date::text AS "entryDate", e.document, e.source, e.notes, e.created_at AS "createdAt", u.name AS "createdByName",
	e.reversed_at AS "reversedAt", e.reversal_reason AS "reversalReason"`;
const ENTRY_FROM = "carcass_entries e LEFT JOIN representatives r ON r.id = e.representative_id LEFT JOIN users u ON u.id = e.created_by";

async function getEntry(id) {
	const { rows } = await database.query(`SELECT ${ENTRY_FIELDS} FROM ${ENTRY_FROM} WHERE e.id = $1`, [id]);
	return rows[0] || null;
}

async function listEntries({ customerId, representativeId, productCode, kind, q, page = 1, pageSize = 50 } = {}) {
	const values = [];
	const clauses = ["TRUE"];
	const add = (sql, value) => {
		values.push(value);
		clauses.push(sql.replaceAll("$V", `$${values.length}`));
	};
	if (customerId) add("e.customer_id = $V", customerId);
	if (representativeId) add("e.representative_id = $V", representativeId);
	if (productCode) add("lower(e.product_code) = lower($V)", productCode);
	if (kind) add("e.kind = $V", kind);
	if (q) add("(e.customer_name ILIKE $V OR e.product_code ILIKE $V OR e.document ILIKE $V)", likeTerm(q));
	const where = clauses.join(" AND ");
	const [{ rows: total }, { rows }] = await Promise.all([
		database.query(`SELECT COUNT(*)::int AS total FROM carcass_entries e WHERE ${where}`, values),
		database.query(
			`SELECT ${ENTRY_FIELDS} FROM ${ENTRY_FROM} WHERE ${where} ORDER BY e.entry_date DESC, e.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
			values
		)
	]);
	return { entries: rows, total: total[0].total, page, totalPages: Math.max(1, Math.ceil(total[0].total / pageSize)) };
}

// ---------------------------------------------------------------- saldos
// Por (cliente, codigo): saldo = debitos + ajustes - devolucoes aproveitaveis.
// Vencidas = max(0, debitos vencidos - creditos), pois os creditos quitam primeiro os mais antigos.
// O representante do saldo e o do debito mais recente daquela linha (ou o padrao do cliente).
const LINES_SQL = `
	WITH lines AS (
		SELECT e.customer_id, MAX(e.customer_name) AS customer_name, e.product_code, MAX(e.product_description) AS product_description,
			SUM(CASE WHEN e.kind = 'debit' THEN e.quantity WHEN e.kind = 'adjustment' AND e.quantity > 0 THEN e.quantity ELSE 0 END) AS debited,
			SUM(CASE WHEN e.kind = 'return' AND e.condition = 'aproveitavel' THEN e.quantity WHEN e.kind = 'adjustment' AND e.quantity < 0 THEN -e.quantity ELSE 0 END) AS credited,
			SUM(CASE WHEN e.kind = 'return' AND e.condition = 'refugada' THEN e.quantity ELSE 0 END) AS refused,
			SUM(CASE WHEN e.kind = 'debit' AND e.due_date < ${TODAY_SQL} THEN e.quantity ELSE 0 END) AS due_debited,
			MIN(e.due_date) FILTER (WHERE e.kind = 'debit') AS first_due,
			(ARRAY_AGG(e.representative_id ORDER BY e.entry_date DESC, e.id DESC) FILTER (WHERE e.kind = 'debit'))[1] AS debit_rep,
			MAX(e.entry_date) AS last_entry
		FROM carcass_entries e WHERE e.reversed_at IS NULL GROUP BY e.customer_id, e.product_code
	)
	SELECT l.*, (l.debited - l.credited) AS outstanding, GREATEST(0, LEAST(l.debited - l.credited, l.due_debited - l.credited)) AS overdue,
		COALESCE(l.debit_rep, c.representative_id) AS representative_id, r.name AS representative_name
	FROM lines l LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN representatives r ON r.id = COALESCE(l.debit_rep, c.representative_id)`;

// Prazo da proxima carcaca a vencer em aberto (FIFO): o primeiro debito ainda nao coberto.
async function nextDueByLine(customerIds) {
	if (!customerIds.length) return new Map();
	const { rows } = await database.query(
		`SELECT e.customer_id, e.product_code, e.kind, e.quantity, e.condition, e.due_date::text AS due_date FROM carcass_entries e
		 WHERE e.reversed_at IS NULL AND e.customer_id = ANY($1::int[]) ORDER BY e.entry_date, e.id`,
		[customerIds]
	);
	const lines = new Map();
	for (const row of rows) {
		const key = `${row.customer_id}|${row.product_code}`;
		if (!lines.has(key)) lines.set(key, { debits: [], credit: 0 });
		const line = lines.get(key);
		if (row.kind === "debit" || (row.kind === "adjustment" && row.quantity > 0)) line.debits.push({ quantity: row.quantity, due: row.due_date });
		else if ((row.kind === "return" && row.condition === "aproveitavel") || (row.kind === "adjustment" && row.quantity < 0))
			line.credit += Math.abs(row.quantity);
	}
	const result = new Map();
	for (const [key, line] of lines) {
		let credit = line.credit;
		for (const debit of line.debits) {
			if (credit >= debit.quantity) {
				credit -= debit.quantity;
				continue;
			}
			result.set(key, debit.due);
			break;
		}
	}
	return result;
}

const toNumber = (row) => ({
	...row,
	debited: Number(row.debited),
	credited: Number(row.credited),
	refused: Number(row.refused),
	outstanding: Number(row.outstanding),
	overdue: Number(row.overdue)
});

/**
 * Saldo agrupado. groupBy: customer | representative. Filtros: q (cliente/representante), representativeId,
 * customerId, onlyOpen (so com saldo), onlyOverdue.
 */
async function summary({ groupBy = "customer", q, representativeId, customerId, onlyOpen = true, onlyOverdue = false } = {}) {
	const { rows: raw } = await database.query(LINES_SQL);
	let lines = raw.map(toNumber);
	if (representativeId) lines = lines.filter((line) => line.representative_id === Number(representativeId));
	if (customerId) lines = lines.filter((line) => line.customer_id === Number(customerId));
	const nextDue = await nextDueByLine([...new Set(lines.map((line) => line.customer_id).filter(Boolean))]);
	const groups = new Map();
	for (const line of lines) {
		const key = groupBy === "representative" ? line.representative_id || 0 : line.customer_id || `n:${line.customer_name}`;
		if (!groups.has(key))
			groups.set(key, {
				key,
				customerId: groupBy === "customer" ? line.customer_id : null,
				name: groupBy === "representative" ? line.representative_name || "Sem representante" : line.customer_name,
				representativeId: line.representative_id,
				representativeName: line.representative_name || "",
				customers: new Set(),
				debited: 0,
				returned: 0,
				refused: 0,
				outstanding: 0,
				overdue: 0,
				nextDue: null,
				lastEntry: null,
				lines: []
			});
		const group = groups.get(key);
		group.customers.add(line.customer_id || line.customer_name);
		group.debited += line.debited;
		group.returned += line.credited;
		group.refused += line.refused;
		group.outstanding += line.outstanding;
		group.overdue += line.overdue;
		const due = line.outstanding > 0 ? nextDue.get(`${line.customer_id}|${line.product_code}`) : null;
		if (due && (!group.nextDue || due < group.nextDue)) group.nextDue = due;
		if (!group.lastEntry || line.last_entry > group.lastEntry) group.lastEntry = line.last_entry;
		group.lines.push({
			customerId: line.customer_id,
			customerName: line.customer_name,
			productCode: line.product_code,
			productDescription: line.product_description,
			debited: line.debited,
			returned: line.credited,
			refused: line.refused,
			outstanding: line.outstanding,
			overdue: line.overdue,
			nextDue: due || null
		});
	}
	const term = String(q || "")
		.trim()
		.toLowerCase();
	let rows = [...groups.values()].map(({ customers, lastEntry, ...group }) => ({
		...group,
		customerCount: customers.size,
		lastEntry: lastEntry ? new Date(lastEntry).toISOString().slice(0, 10) : null,
		lines: group.lines.sort((a, b) => b.outstanding - a.outstanding || a.productCode.localeCompare(b.productCode))
	}));
	if (term) rows = rows.filter((row) => row.name.toLowerCase().includes(term) || row.representativeName.toLowerCase().includes(term));
	if (onlyOpen) rows = rows.filter((row) => row.outstanding !== 0);
	if (onlyOverdue) rows = rows.filter((row) => row.overdue > 0);
	rows.sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding || a.name.localeCompare(b.name));
	const totals = rows.reduce(
		(sum, row) => ({
			outstanding: sum.outstanding + row.outstanding,
			overdue: sum.overdue + row.overdue,
			debtors: sum.debtors + (groupBy === "customer" ? (row.outstanding > 0 ? 1 : 0) : row.customerCount)
		}),
		{ outstanding: 0, overdue: 0, debtors: 0 }
	);
	const { rows: month } = await database.query(
		`SELECT COALESCE(SUM(quantity) FILTER (WHERE condition = 'aproveitavel'), 0)::int AS returned, COALESCE(SUM(quantity) FILTER (WHERE condition = 'refugada'), 0)::int AS refused
		 FROM carcass_entries WHERE kind = 'return' AND reversed_at IS NULL AND entry_date >= date_trunc('month', ${TODAY_SQL})`
	);
	return { groupBy, rows, totals: { ...totals, returnedThisMonth: month[0].returned, refusedThisMonth: month[0].refused } };
}

// ---------------------------------------------------------------- Omie
// NF-e de saida (nao cancelada, nao devolucao) com peca marcada como remanufaturada -> debito automatico.
// Idempotente pela chave da nota + codigo; nota cancelada estorna o debito.
async function fromInvoice(invoice, mirrorKey) {
	const start = await settings.get("carcass_omie_start", null);
	if (!start || !invoice || invoice.type !== "saida" || invoice.isReturn) return 0;
	const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(invoice.date || ""));
	const issued = match ? `${match[3]}-${match[2]}-${match[1]}` : null;
	if (!issued || issued < start) return 0;
	const codes = [...new Set((invoice.items || []).map((item) => item.productCode))];
	if (!codes.length) return 0;
	const { rows: remanufactured } = await database.query(
		"SELECT lower(code) AS code FROM products WHERE remanufactured = TRUE AND lower(code) = ANY($1::text[])",
		[codes.map((code) => code.toLowerCase())]
	);
	if (!remanufactured.length) return 0;
	const marked = new Set(remanufactured.map((row) => row.code));
	if (invoice.cancelled) {
		await database.query(
			"UPDATE carcass_entries SET reversed_at = NOW(), reversal_reason = 'Nota fiscal cancelada no Omie' WHERE source_key LIKE $1 AND reversed_at IS NULL",
			[`nf:${mirrorKey}:%`]
		);
		return 0;
	}
	const { rows: customers } = invoice.customerCode
		? await database.query("SELECT id, name, representative_id FROM customers WHERE omie_code = $1", [invoice.customerCode])
		: { rows: [] };
	const customer = customers[0];
	const due = addDays(issued, await dueDays());
	const totals = new Map();
	for (const item of invoice.items) {
		if (!marked.has(item.productCode.toLowerCase())) continue;
		const current = totals.get(item.productCode) || { quantity: 0, description: item.description };
		current.quantity += item.quantity;
		totals.set(item.productCode, current);
	}
	let created = 0;
	for (const [code, item] of totals) {
		const { rowCount } = await database.query(
			`INSERT INTO carcass_entries (kind, customer_id, customer_name, representative_id, product_code, product_description, quantity, due_date, entry_date, document, source, source_key)
			 VALUES ('debit', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'omie_nf', $10) ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING`,
			[
				customer?.id || null,
				customer?.name || invoice.customerName || "Cliente nao sincronizado",
				customer?.representative_id || null,
				code.toUpperCase(),
				item.description,
				item.quantity,
				due,
				issued,
				`NF ${invoice.number}${invoice.series ? `/${invoice.series}` : ""}`,
				`nf:${mirrorKey}:${code.toLowerCase()}`
			]
		);
		created += rowCount;
	}
	return created;
}

// ---------------------------------------------------------------- avisos de vencimento
// Uma vez por dia: avisa gerentes e administradores sobre as carcacas que venceram desde o ultimo aviso.
async function notifyOverdue() {
	const today = todayIso();
	const last = await settings.get("carcass_last_notified", null);
	if (last === today) return 0;
	const { rows } = await database.query(
		`SELECT e.customer_name, SUM(e.quantity)::int AS quantity FROM carcass_entries e
		 WHERE e.kind = 'debit' AND e.reversed_at IS NULL AND e.due_date < ${TODAY_SQL} AND ($1::date IS NULL OR e.due_date >= $1::date)
		 GROUP BY e.customer_name ORDER BY quantity DESC LIMIT 20`,
		[last]
	);
	await database.query(
		"INSERT INTO app_settings (key, value) VALUES ('carcass_last_notified', to_jsonb($1::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
		[today]
	);
	settings.invalidate();
	if (!rows.length) return 0;
	// Ainda em aberto? (saldo vencido > 0 na linha do cliente)
	const { rows: open } = await database.query(
		`SELECT customer_name, SUM(overdue)::int AS overdue FROM (${LINES_SQL}) x GROUP BY customer_name HAVING SUM(overdue) > 0`
	);
	const overdueByName = new Map(open.map((row) => [row.customer_name, row.overdue]));
	const names = rows.filter((row) => overdueByName.get(row.customer_name)).map((row) => `${row.customer_name} (${overdueByName.get(row.customer_name)})`);
	if (!names.length) return 0;
	const message = `Carcaças com prazo vencido: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` e mais ${names.length - 5}` : ""}.`;
	const { rows: managers } = await database.query("SELECT id FROM users WHERE active = TRUE AND role IN ('admin', 'manager')");
	for (const manager of managers) await notifications.notifyUser(manager.id, null, "CARCASS_OVERDUE", message);
	return managers.length;
}

function startCarcassScheduler() {
	const tick = () => notifyOverdue().catch((error) => logEvent("carcass_notify_error", { error: error.message }));
	const timer = setInterval(tick, 3600000);
	timer.unref?.();
	setTimeout(tick, 60000).unref?.();
	return timer;
}

module.exports = { createEntry, reverseEntry, listEntries, getEntry, summary, fromInvoice, notifyOverdue, startCarcassScheduler, dueDays, addDays };
