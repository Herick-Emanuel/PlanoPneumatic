const { database } = require("../db");
const { FINISHED_STATUSES } = require("../domain/constants");
const { roles } = require("../domain/constants");
const { buildCaseFilters, SAO_PAULO_DATE, FINISHED_SQL } = require("./caseFilters");
const settings = require("./settings");
const { formatCase } = require("./cases");

const OVERDUE_SQL = `c.status NOT IN (${FINISHED_SQL}) AND c.sla_paused_at IS NULL AND c.due_at < NOW()`;
const COMPLETED_SQL = "c.status IN ('Concluido', 'Encerrado')";

async function dashboardSummary(user, query) {
	const { where, values } = buildCaseFilters(user, query);
	const run = (sql, params = values) => database.query(sql, params).then((result) => result.rows);
	const [indicators] = await run(`SELECT
		COUNT(*) FILTER (WHERE c.status NOT IN (${FINISHED_SQL}))::int AS open_cases,
		COUNT(*) FILTER (WHERE ${COMPLETED_SQL})::int AS completed,
		COUNT(*) FILTER (WHERE c.status = 'Aguardando documento')::int AS critical_pending,
		COUNT(*) FILTER (WHERE ${OVERDUE_SQL})::int AS overdue,
		COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(c.closed_at, c.updated_at) - c.created_at)) / 86400) FILTER (WHERE ${COMPLETED_SQL}), 0)::numeric(10,1) AS average_days
		FROM cases c WHERE ${where}`);
	const recentCases = await run(`SELECT c.* FROM cases c WHERE ${where} ORDER BY c.updated_at DESC LIMIT 10`);
	const byType = await run(`SELECT c.type AS label, COUNT(*)::int AS value FROM cases c WHERE ${where} GROUP BY c.type ORDER BY value DESC`);
	const byStatus = await run(`SELECT c.status AS label, COUNT(*)::int AS value FROM cases c WHERE ${where} GROUP BY c.status ORDER BY value DESC`);
	const evolution = await run(`SELECT ${SAO_PAULO_DATE("c.updated_at")}::text AS date, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${COMPLETED_SQL})::int AS completed FROM cases c WHERE ${where} GROUP BY 1 ORDER BY 1`);
	const myPending = await run(`SELECT c.case_number AS id, c.client, c.type, c.status, c.responsible, c.updated_at AS "updatedAt", CASE WHEN c.status = 'Aguardando documento' OR (${OVERDUE_SQL}) THEN 'Alto' ELSE 'Medio' END AS risk FROM cases c WHERE c.assigned_to = $1 AND c.archived_at IS NULL AND c.status NOT IN (${FINISHED_SQL}) ORDER BY c.updated_at ASC LIMIT 8`, [user.id]);
	const alertsEnabled = await settings.get("alerts_enabled", true);
	const alerts = alertsEnabled
		? await run(`SELECT c.case_number AS id, c.client, c.type, c.status, c.responsible, c.updated_at AS "updatedAt", c.due_at AS "dueAt", (c.due_at < NOW()) AS overdue FROM cases c WHERE ${where} AND c.status NOT IN (${FINISHED_SQL}) AND c.sla_paused_at IS NULL AND c.due_at < NOW() + INTERVAL '24 hours' ORDER BY c.due_at ASC LIMIT 8`)
		: [];
	const { where: scopeWhere, values: scopeValues } = buildCaseFilters(user, {});
	const [comparison] = await run(`SELECT
		COUNT(*) FILTER (WHERE c.status NOT IN (${FINISHED_SQL}))::int AS open_cases,
		COUNT(*) FILTER (WHERE ${COMPLETED_SQL})::int AS completed
		FROM cases c WHERE ${scopeWhere} AND ${SAO_PAULO_DATE("c.updated_at")} >= COALESCE($${scopeValues.length + 1}::date, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - 14) - 14
		AND ${SAO_PAULO_DATE("c.updated_at")} < COALESCE($${scopeValues.length + 2}::date, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date + 1) - 14`, [...scopeValues, query.from || null, query.to || null]);
	return {
		filters: query,
		indicators: [
			{ label: "Processos abertos", value: indicators.open_cases, tone: "blue" },
			{ label: "Processos concluidos", value: indicators.completed, tone: "green" },
			{ label: "Tempo medio (dias)", value: Number(indicators.average_days), tone: "orange" },
			{ label: "Pendencias criticas", value: indicators.critical_pending, tone: "red" },
			{ label: "Processos atrasados", value: indicators.overdue, tone: "red" }
		],
		comparison: { openCases: comparison.open_cases, completed: comparison.completed },
		recentCases: recentCases.map(formatCase),
		byType, byStatus, evolution, myPending, alerts
	};
}

async function pendingItems(user) {
	const { where, values } = buildCaseFilters(user, {});
	const { rows } = await database.query(
		`SELECT c.case_number AS id, c.client, c.type, c.status, c.responsible, c.updated_at AS "updatedAt", c.due_at AS "dueAt",
			CASE WHEN c.status = 'Aguardando documento' THEN 'Documentacao pendente' WHEN c.status = 'Em analise' THEN 'Aguardando analise' WHEN ${OVERDUE_SQL} THEN 'Prazo vencido' ELSE 'Revisao necessaria' END AS description,
			CASE WHEN c.status = 'Aguardando documento' OR (${OVERDUE_SQL}) THEN 'Alto' ELSE 'Medio' END AS risk
		 FROM cases c WHERE ${where} AND c.status NOT IN ('Aprovado', 'Concluido', 'Encerrado', 'Cancelado')
		 ORDER BY CASE WHEN c.status = 'Aguardando documento' THEN 1 ELSE 2 END, c.updated_at ASC LIMIT 200`, values);
	return rows;
}

async function reportsSummary(user, query) {
	const { where, values } = buildCaseFilters(user, query);
	const run = (sql) => database.query(sql, values).then((result) => result.rows);
	const [totals] = await run(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE c.status = 'Aguardando documento')::int AS pending, COUNT(*) FILTER (WHERE c.type = 'Garantia' AND c.status = 'Em analise')::int AS guarantees_in_analysis, COUNT(*) FILTER (WHERE c.status IN ('Aprovado', 'Concluido', 'Encerrado'))::int AS completed FROM cases c WHERE ${where}`);
	const byType = await run(`SELECT c.type AS label, COUNT(*)::int AS value FROM cases c WHERE ${where} GROUP BY c.type ORDER BY value DESC`);
	const events = await run(`SELECT c.case_number AS id, e.event_type AS type, e.description, e.responsible, e.created_at AS "createdAt" FROM case_events e JOIN cases c ON c.id = e.case_id WHERE ${where} ORDER BY e.created_at DESC LIMIT 20`);
	const productivity = await run(`SELECT c.responsible AS "user", COUNT(*)::int AS total, COUNT(*) FILTER (WHERE c.status IN ('Aprovado', 'Concluido', 'Encerrado'))::int AS completed FROM cases c WHERE ${where} GROUP BY c.responsible ORDER BY completed DESC, total DESC`);
	const stageTime = await run(`SELECT stage, ROUND(AVG(days_between)::numeric, 1) AS average_days FROM (SELECT e.event_type AS stage, EXTRACT(EPOCH FROM (e.created_at - LAG(e.created_at) OVER (PARTITION BY e.case_id ORDER BY e.created_at))) / 86400 AS days_between FROM case_events e JOIN cases c ON c.id = e.case_id WHERE ${where}) transitions WHERE days_between IS NOT NULL GROUP BY stage ORDER BY average_days DESC NULLS LAST`);
	const stalled = await run(`SELECT c.case_number AS id, c.client, c.type, c.status, c.responsible, c.updated_at AS "updatedAt", c.due_at AS "dueAt" FROM cases c WHERE ${where} AND ${OVERDUE_SQL} ORDER BY c.due_at ASC LIMIT 100`);
	return { filters: query, totals, byType, events, productivity, stageTime, stalled };
}

// Relatorio por cliente ou por produto (reincidencia de defeito).
async function groupedReport(user, query, group) {
	const { where, values } = buildCaseFilters(user, query);
	const keyColumn = group === "customer" ? "c.client" : "c.product_code";
	const labelColumn = group === "customer" ? "c.client" : "MAX(c.product)";
	const { rows } = await database.query(
		`SELECT ${keyColumn} AS key, ${labelColumn} AS label, COUNT(*)::int AS total,
			COUNT(*) FILTER (WHERE c.type = 'Garantia')::int AS warranties,
			COUNT(*) FILTER (WHERE c.type = 'Base de troca')::int AS exchanges,
			COUNT(*) FILTER (WHERE c.type = 'Pedido de venda')::int AS orders,
			COALESCE(SUM(c.quantity), 0)::int AS quantity,
			COUNT(*) FILTER (WHERE c.type <> 'Pedido de venda')::int AS recurrences,
			MAX(c.updated_at) AS "lastAt"
		 FROM cases c WHERE ${where} AND ${keyColumn} IS NOT NULL GROUP BY ${keyColumn} ORDER BY total DESC, label LIMIT 200`, values);
	return rows;
}

async function exportRows(user, query) {
	const { where, values } = buildCaseFilters(user, query);
	const { rows } = await database.query(
		`SELECT c.case_number, c.client, c.client_document, c.type, c.status, c.responsible, c.product, c.product_code, c.quantity, c.document_reference, c.unit_price, c.due_at, c.created_at, c.updated_at
		 FROM cases c WHERE ${where} ORDER BY c.updated_at DESC LIMIT 5000`, values);
	return rows;
}

async function teamPerformance(user, query) {
	const scopeManagerId = user.role === roles.MANAGER ? user.id : (Number.isInteger(Number(query.managerId)) && query.managerId ? Number(query.managerId) : null);
	const managerFilter = scopeManagerId ? "AND (u.id = $1 OR u.manager_id = $1)" : "";
	const values = scopeManagerId ? [scopeManagerId] : [];
	const { rows: individuals } = await database.query(`
		SELECT u.id, u.name, u.role,
			CASE WHEN u.role = 'manager' THEN u.id ELSE u.manager_id END AS "teamOwnerId",
			CASE WHEN u.role = 'manager' THEN u.name ELSE mgr.name END AS "teamOwnerName",
			COUNT(c.id)::int AS "casesRegistered",
			COALESCE(SUM(c.quantity), 0)::int AS "partsRegistered",
			COUNT(c.id) FILTER (WHERE c.created_at >= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo'))::int AS "casesThisMonth"
		FROM users u
		LEFT JOIN users mgr ON mgr.id = u.manager_id
		LEFT JOIN cases c ON c.created_by = u.id
		WHERE u.active = TRUE AND u.role IN ('operator', 'manager') ${managerFilter}
		GROUP BY u.id, u.name, u.role, mgr.name
		ORDER BY "partsRegistered" DESC`, values);
	const { rows: goals } = await database.query("SELECT manager_id AS \"managerId\", monthly_target AS \"monthlyTarget\" FROM team_goals");
	const goalByManager = new Map(goals.map((goal) => [goal.managerId, goal.monthlyTarget]));
	const teams = new Map();
	for (const row of individuals) {
		const key = row.teamOwnerId || 0;
		if (!teams.has(key)) teams.set(key, { managerId: row.teamOwnerId || null, managerName: row.teamOwnerName || "Sem time", casesRegistered: 0, partsRegistered: 0, casesThisMonth: 0, monthlyTarget: goalByManager.get(row.teamOwnerId) || null, members: [] });
		const team = teams.get(key);
		team.casesRegistered += row.casesRegistered;
		team.partsRegistered += row.partsRegistered;
		team.casesThisMonth += row.casesThisMonth;
		team.members.push({ id: row.id, name: row.name, role: row.role, casesRegistered: row.casesRegistered, partsRegistered: row.partsRegistered, casesThisMonth: row.casesThisMonth });
	}
	return { teams: [...teams.values()], individuals };
}

async function managerPerformance() {
	const { rows } = await database.query(`
		SELECT m.id, m.name, m.email,
			COUNT(DISTINCT team.id)::int AS "teamSize",
			COALESCE(activity.total_actions, 0)::int AS "totalActions",
			COALESCE(activity.navigation_count, 0)::int AS "navigationCount",
			COALESCE(activity.click_count, 0)::int AS "clickCount",
			COALESCE(activity.active_days, 0)::int AS "activeDays",
			activity.last_activity_at AS "lastActivityAt",
			COALESCE(cases_stats.total_cases, 0)::int AS "teamCases",
			COALESCE(cases_stats.completed_cases, 0)::int AS "teamCompletedCases"
		FROM users m
		LEFT JOIN users team ON team.manager_id = m.id
		LEFT JOIN LATERAL (
			SELECT COUNT(*)::int AS total_actions,
				COUNT(*) FILTER (WHERE action = 'navigation')::int AS navigation_count,
				COUNT(*) FILTER (WHERE action = 'click')::int AS click_count,
				COUNT(DISTINCT created_at::date)::int AS active_days,
				MAX(created_at) AS last_activity_at
			FROM user_activity_log WHERE user_id = m.id
		) activity ON TRUE
		LEFT JOIN LATERAL (
			SELECT COUNT(*)::int AS total_cases, COUNT(*) FILTER (WHERE status IN ('Aprovado', 'Concluido', 'Encerrado'))::int AS completed_cases
			FROM cases WHERE created_by IN (SELECT id FROM users WHERE manager_id = m.id OR id = m.id)
		) cases_stats ON TRUE
		WHERE m.role = 'manager'
		GROUP BY m.id, activity.total_actions, activity.navigation_count, activity.click_count, activity.active_days, activity.last_activity_at, cases_stats.total_cases, cases_stats.completed_cases
		ORDER BY m.name`);
	return rows.map((row) => ({ ...row, engagementScore: Math.min(100, Math.round((row.totalActions || 0) * 0.6 + (row.activeDays || 0) * 4 + (row.teamCompletedCases || 0) * 2)) }));
}

// F15: tempo medio por etapa (entre eventos de status), reincidencia, custo estimado de garantia e comparativo mensal.
async function advancedDashboard(user, query) {
	const { where, values } = buildCaseFilters(user, query);
	const run = (sql) => database.query(sql, values).then((result) => result.rows);
	const monthly = await run(`SELECT to_char(date_trunc('month', c.created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS month, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${COMPLETED_SQL})::int AS completed FROM cases c WHERE ${where} GROUP BY 1 ORDER BY 1 DESC LIMIT 12`);
	const stageDurations = await run(`SELECT e.details->>'to' AS stage, ROUND(AVG(EXTRACT(EPOCH FROM (next_at - e.created_at)) / 86400)::numeric, 1) AS average_days FROM (SELECT e.case_id, e.created_at, e.details, LEAD(e.created_at) OVER (PARTITION BY e.case_id ORDER BY e.created_at, e.id) AS next_at FROM case_events e WHERE e.event_type IN ('STATUS', 'REABERTURA')) e JOIN cases c ON c.id = e.case_id WHERE ${where} AND next_at IS NOT NULL AND e.details->>'to' IS NOT NULL GROUP BY 1 ORDER BY average_days DESC`);
	const recurrence = await run(`SELECT c.product_code AS "productCode", MAX(c.product) AS product, COUNT(*)::int AS total FROM cases c WHERE ${where} AND c.type IN ('Garantia', 'Base de troca') AND c.product_code IS NOT NULL GROUP BY c.product_code HAVING COUNT(*) > 1 ORDER BY total DESC LIMIT 10`);
	const [cost] = await run(`SELECT COALESCE(SUM(c.quantity * c.unit_price), 0)::numeric(14,2) AS estimated_cost, COUNT(*)::int AS approved FROM cases c WHERE ${where} AND c.type = 'Garantia' AND c.warranty_decision = 'procedente' AND c.unit_price IS NOT NULL`);
	const { rows: goals } = await database.query("SELECT g.manager_id AS \"managerId\", u.name AS \"managerName\", g.monthly_target AS \"monthlyTarget\", COALESCE((SELECT COUNT(*) FROM cases c2 JOIN users u2 ON u2.id = c2.created_by WHERE (u2.id = g.manager_id OR u2.manager_id = g.manager_id) AND c2.created_at >= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')), 0)::int AS achieved FROM team_goals g JOIN users u ON u.id = g.manager_id ORDER BY u.name");
	return { monthly: monthly.reverse(), stageDurations, recurrence, warrantyCost: { estimated: Number(cost.estimated_cost), approved: cost.approved }, goals };
}

module.exports = { dashboardSummary, pendingItems, reportsSummary, groupedReport, exportRows, teamPerformance, managerPerformance, advancedDashboard, FINISHED_STATUSES };
