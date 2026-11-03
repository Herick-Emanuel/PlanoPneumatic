const { can, capabilities } = require("../domain/permissions");
const { FINISHED_STATUSES } = require("../domain/constants");

const SAO_PAULO_DATE = (column) => `(${column} AT TIME ZONE 'America/Sao_Paulo')::date`;
const FINISHED_SQL = FINISHED_STATUSES.map((status) => `'${status}'`).join(", ");

function likeTerm(value) {
	return `%${String(value).trim().replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * Monta o WHERE de casos (tabela `cases c`), sempre com escopo por perfil.
 * Retorna { where, values } - `where` ja inclui o escopo e o filtro de arquivados.
 */
function buildCaseFilters(user, query = {}) {
	const values = [];
	const clauses = [];
	const add = (condition, value) => {
		values.push(value);
		const placeholder = `$${values.length}`;
		clauses.push(condition.replaceAll("$V", () => placeholder));
	};

	if (!can(user, capabilities.VIEW_ALL_CASES)) add("(c.created_by = $V OR c.assigned_to = $V)", user.id);
	if (query.mine === "true") add("(c.assigned_to = $V OR c.created_by = $V)", user.id);
	clauses.push(query.archived === "true" ? "c.archived_at IS NOT NULL" : "c.archived_at IS NULL");

	if (query.process) add("c.case_number ILIKE $V", likeTerm(query.process));
	if (query.client) add("c.client ILIKE $V", likeTerm(query.client));
	if (query.product) add("c.product ILIKE $V", likeTerm(query.product));
	if (query.productCode) add("c.product_code ILIKE $V", likeTerm(query.productCode));
	if (query.document) add("(c.document_reference ILIKE $V OR c.client_document ILIKE $V OR c.origin_order ILIKE $V)", likeTerm(query.document));
	if (query.serial) add("(c.serial_number ILIKE $V OR c.lot_number ILIKE $V OR EXISTS (SELECT 1 FROM case_items i WHERE i.case_id = c.id AND (i.serial_number ILIKE $V OR i.lot_number ILIKE $V)))", likeTerm(query.serial));
	if (query.responsible) add("c.responsible ILIKE $V", likeTerm(query.responsible));
	if (query.assignedTo) add("c.assigned_to = $V", query.assignedTo);
	if (query.type) add("c.type = $V", query.type);
	if (query.status) add("c.status = $V", query.status);
	if (query.from) add(`${SAO_PAULO_DATE("c.updated_at")} >= $V::date`, query.from);
	if (query.to) add(`${SAO_PAULO_DATE("c.updated_at")} <= $V::date`, query.to);
	if (query.updatedAt) add(`${SAO_PAULO_DATE("c.updated_at")} = $V::date`, query.updatedAt);
	if (query.overdue === "true") clauses.push(`c.status NOT IN (${FINISHED_SQL}) AND c.sla_paused_at IS NULL AND c.due_at < NOW()`);

	return { where: clauses.join(" AND "), values };
}

module.exports = { buildCaseFilters, likeTerm, SAO_PAULO_DATE, FINISHED_SQL };
