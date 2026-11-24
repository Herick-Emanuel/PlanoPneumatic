// Construtor de relatorios (administrador e gerente): a pessoa escolhe a fonte, as colunas, o agrupamento,
// as metricas e os filtros. Tudo vem de listas fechadas abaixo - nenhum nome de coluna do cliente entra no SQL.
const { z } = require("zod");
const { database } = require("../db");
const { STATUS_LABELS, CASE_TYPES, STATUSES, DONE_STATUSES } = require("../domain/constants");
const { buildCaseFilters, SAO_PAULO_DATE, FINISHED_SQL } = require("./caseFilters");
const { formatDateTime } = require("./exports");

const DONE_SQL = DONE_STATUSES.map((status) => `'${status}'`).join(", ");
const OVERDUE_SQL = `(c.status NOT IN (${FINISHED_SQL}) AND c.sla_paused_at IS NULL AND c.due_at < NOW())`;
const MONTH_SQL = (column) => `to_char(date_trunc('month', ${column} AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM')`;

// kind: text | number | money | date | status | bool
const SOURCES = Object.freeze({
	cases: {
		label: "Processos",
		dateLabel: "Atualizados no período",
		from: "cases c",
		columns: {
			case_number: { header: "Processo", sql: "c.case_number", kind: "text", width: 18 },
			client: { header: "Cliente", sql: "c.client", kind: "text", width: 32 },
			client_document: { header: "CPF/CNPJ", sql: "c.client_document", kind: "text", width: 18 },
			type: { header: "Tipo", sql: "c.type", kind: "text", width: 16 },
			status: { header: "Status", sql: "c.status", kind: "status", width: 20 },
			responsible: { header: "Responsável", sql: "c.responsible", kind: "text", width: 22 },
			product: { header: "Produto", sql: "c.product", kind: "text", width: 30 },
			product_code: { header: "Código do produto", sql: "c.product_code", kind: "text", width: 16 },
			quantity: { header: "Quantidade", sql: "c.quantity", kind: "number", width: 10 },
			unit_price: { header: "Valor unitário", sql: "c.unit_price", kind: "money", width: 14 },
			total_value: { header: "Valor total", sql: "(c.quantity * c.unit_price)", kind: "money", width: 14 },
			document_reference: { header: "Documento de origem", sql: "c.document_reference", kind: "text", width: 22 },
			serial_number: { header: "Série", sql: "c.serial_number", kind: "text", width: 16 },
			lot_number: { header: "Lote", sql: "c.lot_number", kind: "text", width: 16 },
			warranty_decision: { header: "Decisão da garantia", sql: "c.warranty_decision", kind: "text", width: 16 },
			created_at: { header: "Criado em", sql: "c.created_at", kind: "date", width: 18 },
			updated_at: { header: "Atualizado em", sql: "c.updated_at", kind: "date", width: 18 },
			due_at: { header: "Prazo (SLA)", sql: "c.due_at", kind: "date", width: 18 },
			closed_at: { header: "Encerrado em", sql: "c.closed_at", kind: "date", width: 18 },
			overdue: { header: "Atrasado", sql: OVERDUE_SQL, kind: "bool", width: 10 },
			days_open: {
				header: "Dias em aberto",
				sql: "ROUND((EXTRACT(EPOCH FROM (COALESCE(c.closed_at, NOW()) - c.created_at)) / 86400)::numeric, 1)",
				kind: "number",
				width: 12
			}
		},
		groups: {
			type: { header: "Tipo", sql: "c.type", kind: "text" },
			status: { header: "Status", sql: "c.status", kind: "status" },
			responsible: { header: "Responsável", sql: "c.responsible", kind: "text" },
			client: { header: "Cliente", sql: "c.client", kind: "text" },
			product_code: { header: "Código do produto", sql: "c.product_code", kind: "text" },
			month: { header: "Mês de criação", sql: MONTH_SQL("c.created_at"), kind: "text" }
		},
		metrics: {
			count: { header: "Processos", sql: "COUNT(*)::int", kind: "number" },
			quantity: { header: "Peças", sql: "COALESCE(SUM(c.quantity), 0)::int", kind: "number" },
			value: { header: "Valor total", sql: "COALESCE(SUM(c.quantity * c.unit_price), 0)::numeric(14,2)", kind: "money" },
			completed: { header: "Concluídos", sql: `COUNT(*) FILTER (WHERE c.status IN (${DONE_SQL}))::int`, kind: "number" },
			overdue: { header: "Atrasados", sql: `COUNT(*) FILTER (WHERE ${OVERDUE_SQL})::int`, kind: "number" },
			avg_days: {
				header: "Tempo médio até concluir (dias)",
				sql: `ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(c.closed_at, c.updated_at) - c.created_at)) / 86400) FILTER (WHERE c.status IN (${DONE_SQL}))::numeric, 1)`,
				kind: "number"
			}
		}
	},
	events: {
		label: "Eventos (linha do tempo)",
		dateLabel: "Eventos no período",
		from: "case_events e JOIN cases c ON c.id = e.case_id",
		columns: {
			case_number: { header: "Processo", sql: "c.case_number", kind: "text", width: 18 },
			case_type: { header: "Tipo do processo", sql: "c.type", kind: "text", width: 16 },
			client: { header: "Cliente", sql: "c.client", kind: "text", width: 30 },
			event_type: { header: "Evento", sql: "e.event_type", kind: "text", width: 16 },
			description: { header: "Descrição", sql: "e.description", kind: "text", width: 48 },
			responsible: { header: "Responsável", sql: "e.responsible", kind: "text", width: 22 },
			created_at: { header: "Data", sql: "e.created_at", kind: "date", width: 18 }
		},
		groups: {
			event_type: { header: "Evento", sql: "e.event_type", kind: "text" },
			responsible: { header: "Responsável", sql: "e.responsible", kind: "text" },
			case_type: { header: "Tipo do processo", sql: "c.type", kind: "text" },
			month: { header: "Mês", sql: MONTH_SQL("e.created_at"), kind: "text" }
		},
		metrics: {
			count: { header: "Eventos", sql: "COUNT(*)::int", kind: "number" },
			cases: { header: "Processos distintos", sql: "COUNT(DISTINCT c.id)::int", kind: "number" }
		}
	}
});

const optionalDate = z
	.string()
	.trim()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Data invalida.")
	.optional()
	.or(z.literal("").transform(() => undefined));
const optionalTerm = z
	.string()
	.trim()
	.max(120)
	.optional()
	.transform((value) => value || undefined);

const definitionSchema = z
	.object({
		source: z.enum(Object.keys(SOURCES)),
		columns: z.array(z.string().max(40)).max(30).default([]),
		groupBy: z
			.string()
			.max(40)
			.nullish()
			.transform((value) => value || null),
		metrics: z.array(z.string().max(40)).max(10).default([]),
		filters: z
			.object({
				from: optionalDate,
				to: optionalDate,
				type: z
					.enum(CASE_TYPES)
					.optional()
					.or(z.literal("").transform(() => undefined)),
				status: z
					.enum(STATUSES)
					.optional()
					.or(z.literal("").transform(() => undefined)),
				responsible: optionalTerm,
				client: optionalTerm,
				productCode: optionalTerm,
				overdue: z.enum(["true", "false"]).optional(),
				archived: z.enum(["true", "false"]).optional()
			})
			.default({}),
		sort: z.object({ key: z.string().max(40).optional(), direction: z.enum(["asc", "desc"]).default("desc") }).default({ direction: "desc" })
	})
	.superRefine((definition, context) => {
		const source = SOURCES[definition.source];
		const issue = (message, path) => context.addIssue({ code: "custom", message, path });
		if (definition.groupBy) {
			if (!source.groups[definition.groupBy]) issue("Agrupamento invalido para esta fonte.", ["groupBy"]);
			if (!definition.metrics.length) issue("Escolha ao menos uma metrica para o agrupamento.", ["metrics"]);
			definition.metrics.forEach((key) => !source.metrics[key] && issue(`Metrica invalida: ${key}.`, ["metrics"]));
		} else {
			if (!definition.columns.length) issue("Escolha ao menos uma coluna.", ["columns"]);
			definition.columns.forEach((key) => !source.columns[key] && issue(`Coluna invalida: ${key}.`, ["columns"]));
		}
	});

// Catalogo para a tela (sem SQL).
function catalog() {
	const strip = (entries) => Object.entries(entries).map(([key, item]) => ({ key, header: item.header, kind: item.kind }));
	return Object.entries(SOURCES).map(([key, source]) => ({
		key,
		label: source.label,
		dateLabel: source.dateLabel,
		columns: strip(source.columns),
		groups: strip(source.groups),
		metrics: strip(source.metrics)
	}));
}

function formatValue(value, kind) {
	if (value === null || value === undefined) return "";
	if (kind === "date") return formatDateTime(value);
	if (kind === "status") return STATUS_LABELS[value] || value;
	if (kind === "bool") return value ? "Sim" : "Não";
	if (kind === "number" || kind === "money") return Number(value);
	return value;
}

function buildQuery(user, definition, limit) {
	const source = SOURCES[definition.source];
	const { from, to, ...caseFilters } = definition.filters;
	// Processos: o periodo vale para a ultima atualizacao (igual aos demais relatorios). Eventos: data do evento.
	const filters = definition.source === "cases" ? definition.filters : caseFilters;
	const { where, values } = buildCaseFilters(user, filters);
	const clauses = [where];
	if (definition.source === "events") {
		if (from) {
			values.push(from);
			clauses.push(`${SAO_PAULO_DATE("e.created_at")} >= $${values.length}::date`);
		}
		if (to) {
			values.push(to);
			clauses.push(`${SAO_PAULO_DATE("e.created_at")} <= $${values.length}::date`);
		}
	}
	const fields = definition.groupBy
		? [{ key: "group", ...source.groups[definition.groupBy] }, ...definition.metrics.map((key) => ({ key, ...source.metrics[key] }))]
		: definition.columns.map((key) => ({ key, ...source.columns[key] }));
	const select = fields.map((field, index) => `${field.sql} AS f${index}`).join(", ");
	const sortIndex = Math.max(
		0,
		fields.findIndex((field) => field.key === definition.sort.key)
	);
	const defaultSort = definition.groupBy ? 1 : fields.findIndex((field) => field.kind === "date");
	const orderIndex = definition.sort.key ? sortIndex : defaultSort >= 0 ? defaultSort : 0;
	const direction = definition.sort.direction === "asc" ? "ASC" : "DESC";
	values.push(limit);
	const sql = `SELECT ${select} FROM ${source.from} WHERE ${clauses.join(" AND ")}${
		definition.groupBy ? ` GROUP BY ${source.groups[definition.groupBy].sql}` : ""
	} ORDER BY f${orderIndex} ${direction} NULLS LAST LIMIT $${values.length}`;
	return { sql, values, fields };
}

async function run(user, rawDefinition, { limit = 5000 } = {}) {
	const definition = definitionSchema.parse(rawDefinition);
	const { sql, values, fields } = buildQuery(user, definition, limit + 1);
	const { rows } = await database.query(sql, values);
	const truncated = rows.length > limit;
	const columns = fields.map((field) => ({ key: field.key, header: field.header, kind: field.kind, width: field.width }));
	const cell = (field, value) => (field.key === "group" && (value === null || value === "") ? "(não informado)" : formatValue(value, field.kind));
	const data = rows.slice(0, limit).map((row) => Object.fromEntries(fields.map((field, index) => [field.key, cell(field, row[`f${index}`])])));
	return { definition, columns, rows: data, truncated };
}

// ---- Modelos salvos
const templateSchema = z.object({
	name: z.string().trim().min(1, "Informe um nome.").max(80),
	description: z.string().trim().max(240).optional().default(""),
	shared: z.boolean().default(false),
	definition: z.unknown()
});

const TEMPLATE_FIELDS = `t.id, t.name, t.description, t.shared, t.definition, t.owner_id AS "ownerId", u.name AS "ownerName", t.created_at AS "createdAt", t.updated_at AS "updatedAt"`;

async function listTemplates(user) {
	const { rows } = await database.query(
		`SELECT ${TEMPLATE_FIELDS} FROM report_templates t JOIN users u ON u.id = t.owner_id WHERE t.owner_id = $1 OR t.shared = TRUE ORDER BY t.name`,
		[user.id]
	);
	return rows.map((row) => ({ ...row, mine: row.ownerId === user.id }));
}

async function getTemplate(user, id) {
	const { rows } = await database.query(
		`SELECT ${TEMPLATE_FIELDS} FROM report_templates t JOIN users u ON u.id = t.owner_id WHERE t.id = $1 AND (t.owner_id = $2 OR t.shared = TRUE)`,
		[id, user.id]
	);
	return rows[0] ? { ...rows[0], mine: rows[0].ownerId === user.id } : null;
}

async function createTemplate(user, body) {
	const data = templateSchema.parse(body);
	const definition = definitionSchema.parse(data.definition);
	const { rows } = await database.query(
		"INSERT INTO report_templates (owner_id, name, description, shared, definition) VALUES ($1, $2, $3, $4, $5) RETURNING id",
		[user.id, data.name, data.description, data.shared, definition]
	);
	return getTemplate(user, rows[0].id);
}

async function updateTemplate(user, id, body) {
	const data = templateSchema.parse(body);
	const definition = definitionSchema.parse(data.definition);
	const { rowCount } = await database.query(
		"UPDATE report_templates SET name = $3, description = $4, shared = $5, definition = $6, updated_at = NOW() WHERE id = $1 AND owner_id = $2",
		[id, user.id, data.name, data.description, data.shared, definition]
	);
	return rowCount ? getTemplate(user, id) : null;
}

async function removeTemplate(user, id) {
	const { rowCount } = await database.query("DELETE FROM report_templates WHERE id = $1 AND owner_id = $2", [id, user.id]);
	return rowCount > 0;
}

async function countTemplates(user) {
	const { rows } = await database.query("SELECT COUNT(*)::int AS total FROM report_templates WHERE owner_id = $1", [user.id]);
	return rows[0].total;
}

module.exports = {
	SOURCES,
	catalog,
	definitionSchema,
	run,
	listTemplates,
	getTemplate,
	createTemplate,
	updateTemplate,
	removeTemplate,
	countTemplates
};
