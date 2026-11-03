const { database } = require("../db");
const { FINISHED_STATUSES } = require("../domain/constants");
const { notifyUser } = require("./notifications");
const { logEvent } = require("../middleware/errors");

const WARNING_WINDOW_MS = 24 * 60 * 60 * 1000;

async function getSlaDays(type, executor = database) {
	const { rows } = await executor.query("SELECT days FROM case_sla_config WHERE type = $1", [type]);
	return rows[0]?.days || 3;
}

async function listSla() {
	const { rows } = await database.query("SELECT type, days, updated_at AS \"updatedAt\" FROM case_sla_config ORDER BY type");
	return rows;
}

// Estado do prazo de um caso: done | paused | overdue | warning | ok
function slaState(item, now = Date.now()) {
	if (FINISHED_STATUSES.includes(item.status)) return "done";
	if (item.sla_paused_at) return "paused";
	if (!item.due_at) return "ok";
	const remaining = new Date(item.due_at).getTime() - now;
	if (remaining < 0) return "overdue";
	if (remaining <= WARNING_WINDOW_MS) return "warning";
	return "ok";
}

// Rotina periodica: avisa o responsavel (uma vez por caso) quando o prazo esta perto ou vencido.
async function runSlaAlerts() {
	const finished = FINISHED_STATUSES.map((status) => `'${status}'`).join(", ");
	const { rows } = await database.query(
		`SELECT id, case_number, assigned_to, created_by, due_at, (due_at < NOW()) AS overdue
		 FROM cases
		 WHERE archived_at IS NULL AND status NOT IN (${finished}) AND sla_paused_at IS NULL AND due_at IS NOT NULL
		   AND due_at < NOW() + INTERVAL '24 hours'
		   AND (sla_notified_at IS NULL OR (due_at < NOW() AND sla_notified_at < due_at))`
	);
	for (const item of rows) {
		const message = item.overdue ? `O prazo do processo ${item.case_number} venceu.` : `O prazo do processo ${item.case_number} vence em menos de 24 horas.`;
		await notifyUser(item.assigned_to || item.created_by, item.id, item.overdue ? "SLA_OVERDUE" : "SLA_DUE", message);
		await database.query("UPDATE cases SET sla_notified_at = NOW() WHERE id = $1", [item.id]);
	}
	if (rows.length) logEvent("sla_alerts_sent", { count: rows.length });
	return rows.length;
}

function startSlaScheduler(intervalMs) {
	const timer = setInterval(() => runSlaAlerts().catch((error) => logEvent("sla_alerts_error", { error: error.message })), intervalMs);
	if (typeof timer.unref === "function") timer.unref();
	return timer;
}

module.exports = { getSlaDays, listSla, slaState, runSlaAlerts, startSlaScheduler };
