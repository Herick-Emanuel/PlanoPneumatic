// F11: relatorios agendados, enviados por e-mail como anexo (XLSX, PDF ou CSV) ao dono do agendamento.
const { database } = require("../db");
const { logEvent } = require("../middleware/errors");
const { can, capabilities } = require("../domain/permissions");
const reports = require("./reports");
const exportsService = require("./exports");
const mailer = require("./mailer");

const FIELDS = `id, name, filters, format, frequency, weekday, hour, active, last_sent_at AS "lastSentAt", last_error AS "lastError", created_at AS "createdAt"`;
const FREQUENCY_LABELS = { daily: "diário", weekly: "semanal", monthly: "mensal" };
const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 31 };
const MIME = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pdf: "application/pdf", csv: "text/csv; charset=utf-8" };

// Horario de Sao Paulo (UTC-3, sem horario de verao desde 2019).
const toLocal = (date) => new Date(date.getTime() - 3 * 3600000);
const localDay = (date) => toLocal(date).toISOString().slice(0, 10);

function isDue(schedule, now = new Date()) {
	if (!schedule.active) return false;
	const local = toLocal(now);
	if (local.getUTCHours() < schedule.hour) return false;
	if (schedule.frequency === "weekly" && local.getUTCDay() !== Number(schedule.weekday ?? 1)) return false;
	if (schedule.frequency === "monthly" && local.getUTCDate() !== 1) return false;
	const last = schedule.lastSentAt || schedule.last_sent_at;
	return !last || localDay(new Date(last)) !== localDay(now);
}

function describe(schedule) {
	const when = schedule.frequency === "weekly" ? `toda ${WEEKDAYS[schedule.weekday ?? 1]}` : schedule.frequency === "monthly" ? "todo dia 1º" : "todos os dias";
	return `${FREQUENCY_LABELS[schedule.frequency]}, ${when} às ${String(schedule.hour).padStart(2, "0")}h`;
}

const list = async (userId) => (await database.query(`SELECT ${FIELDS} FROM report_schedules WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;

async function create(userId, data) {
	const { rows } = await database.query(
		`INSERT INTO report_schedules (user_id, name, filters, format, frequency, weekday, hour) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${FIELDS}`,
		[userId, data.name, JSON.stringify(data.filters || {}), data.format, data.frequency, data.frequency === "weekly" ? data.weekday ?? 1 : null, data.hour]
	);
	return rows[0];
}

async function update(userId, id, { active }) {
	const { rows } = await database.query(`UPDATE report_schedules SET active = $3 WHERE id = $1 AND user_id = $2 RETURNING ${FIELDS}`, [id, userId, active]);
	return rows[0] || null;
}

async function remove(userId, id) {
	const { rowCount } = await database.query("DELETE FROM report_schedules WHERE id = $1 AND user_id = $2", [id, userId]);
	return rowCount > 0;
}

// Gera o arquivo com as permissoes atuais do dono (se perdeu acesso a exportacao, o envio falha com aviso).
async function deliver(scheduleId) {
	const { rows } = await database.query(
		`SELECT s.id, s.name, s.filters, s.format, s.frequency, s.weekday, s.hour, u.id AS user_id, u.name AS user_name, u.email, u.role, u.active AS user_active
		FROM report_schedules s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
		[scheduleId]
	);
	const schedule = rows[0];
	if (!schedule) return { sent: false, error: "Agendamento nao encontrado." };
	const user = { id: schedule.user_id, name: schedule.user_name, email: schedule.email, role: schedule.role };
	try {
		if (!schedule.user_active || !can(user, capabilities.EXPORT_REPORTS)) throw new Error("O usuario nao tem mais permissao para exportar relatorios.");
		if (!mailer.isConfigured()) throw new Error("Envio de e-mail nao configurado no servidor (SMTP_HOST).");
		const filters = { ...(schedule.filters || {}) };
		if (!filters.from && !filters.to) filters.from = new Date(Date.now() - PERIOD_DAYS[schedule.frequency] * 86400000).toISOString().slice(0, 10);
		const data = await reports.exportRows(user, filters);
		const content = schedule.format === "xlsx" ? await exportsService.toXlsx(data) : schedule.format === "pdf" ? await exportsService.toPdf(data) : Buffer.from(exportsService.toCsv(data), "utf8");
		const filename = `${schedule.name.replace(/[^\w.-]+/g, "-").slice(0, 60) || "relatorio"}-${localDay(new Date())}.${schedule.format}`;
		await mailer.send({
			to: schedule.email,
			subject: `PlanoPneumatic: ${schedule.name}`,
			title: schedule.name,
			lines: [`Olá, ${schedule.user_name.split(" ")[0]}.`, `Segue o relatório agendado (${describe(schedule)}) com ${data.length} processo(s), a partir de ${filters.from || "o início"}.`, "Para mudar ou cancelar o envio, abra Relatórios > Envios agendados."],
			action: { label: "Abrir relatórios", url: mailer.appUrl("/relatorios.html") },
			attachments: [{ filename, content, contentType: MIME[schedule.format] }]
		});
		await database.query("UPDATE report_schedules SET last_sent_at = NOW(), last_error = NULL WHERE id = $1", [schedule.id]);
		logEvent("report_schedule_sent", { scheduleId: schedule.id, rows: data.length });
		return { sent: true, rows: data.length };
	} catch (error) {
		// Registra o envio para nao repetir no mesmo dia; o erro fica visivel na tela.
		await database.query("UPDATE report_schedules SET last_sent_at = NOW(), last_error = $2 WHERE id = $1", [schedule.id, error.message.slice(0, 500)]);
		logEvent("report_schedule_error", { scheduleId: schedule.id, error: error.message });
		return { sent: false, error: error.message };
	}
}

async function runDue(now = new Date()) {
	const { rows } = await database.query(`SELECT ${FIELDS} FROM report_schedules WHERE active = TRUE`);
	const due = rows.filter((schedule) => isDue(schedule, now));
	for (const schedule of due) await deliver(schedule.id);
	return due.length;
}

function startReportScheduler(intervalMs = 10 * 60 * 1000) {
	const timer = setInterval(() => runDue().catch((error) => logEvent("report_scheduler_error", { error: error.message })), intervalMs);
	if (typeof timer.unref === "function") timer.unref();
	return timer;
}

module.exports = { list, create, update, remove, deliver, runDue, isDue, describe, startReportScheduler };
