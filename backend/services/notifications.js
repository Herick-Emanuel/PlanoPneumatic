const { database } = require("../db");
const { logEvent } = require("../middleware/errors");
const mailer = require("./mailer");
const whatsapp = require("./whatsapp");

const KIND_TITLES = {
	CASE_ASSIGNED: "Processo atribuído a você",
	STATUS_CHANGED: "Mudança de status",
	SLA_DUE: "Prazo perto de vencer",
	SLA_OVERDUE: "Prazo vencido",
	COMMERCIAL_DIVERGENCE: "Divergência comercial com o Omie",
	CARCASS_OVERDUE: "Carcaças com prazo vencido"
};

// Envios por e-mail e WhatsApp rodam fora da requisicao; idle() deixa os testes esperarem o fim.
const pending = new Set();
const idle = () => Promise.allSettled([...pending]);

async function recordDelivery(notificationId, userId, channel, result) {
	await database.query("INSERT INTO notification_deliveries (notification_id, user_id, channel, status, error) VALUES ($1, $2, $3, $4, $5)", [
		notificationId,
		userId,
		channel,
		result.delivered ? "sent" : "skipped",
		result.delivered ? null : result.reason || null
	]);
}

// Le a notificacao ja gravada (se a transacao que a criou foi desfeita, nada e enviado).
async function deliverChannels(notificationId) {
	const { rows } = await database.query(
		`SELECT n.id, n.kind, n.message, c.case_number, u.id AS user_id, u.email, u.phone, u.notify_email, u.notify_whatsapp, u.active
		 FROM notifications n JOIN users u ON u.id = n.user_id LEFT JOIN cases c ON c.id = n.case_id WHERE n.id = $1`,
		[notificationId]
	);
	const item = rows[0];
	if (!item || !item.active) return;
	const title = KIND_TITLES[item.kind] || "Aviso do PlanoPneumatic";
	// Canal sem configuracao no servidor nao gera tentativa nem registro.
	if (item.notify_email && item.email && mailer.isConfigured()) {
		const result = await mailer
			.send({
				to: item.email,
				subject: `PlanoPneumatic: ${title}${item.case_number ? ` · ${item.case_number}` : ""}`,
				title,
				lines: [item.message, "Você recebe este aviso porque está participando do processo. Desative os e-mails em Minha conta."],
				action: item.case_number ? { label: "Abrir o processo", url: mailer.appUrl(`/caso.html?id=${encodeURIComponent(item.case_number)}`) } : undefined
			})
			.catch((error) => ({ delivered: false, reason: error.message }));
		await recordDelivery(item.id, item.user_id, "email", result);
	}
	if (item.notify_whatsapp && item.phone && whatsapp.isConfigured()) {
		const result = await whatsapp.send(item.phone, `${title}: ${item.message}`).catch((error) => ({ delivered: false, reason: error.message }));
		await recordDelivery(item.id, item.user_id, "whatsapp", result);
	}
}

function scheduleDelivery(notificationId) {
	const task = new Promise((resolve) => setTimeout(resolve, process.env.NODE_ENV === "test" ? 50 : 1500))
		.then(() => deliverChannels(notificationId))
		.catch((error) => logEvent("notification_channel_error", { error: error.message }));
	pending.add(task);
	task.finally(() => pending.delete(task));
}

async function notifyUser(userId, caseId, kind, message, executor = database) {
	if (!userId) return;
	const { rows } = await executor.query("INSERT INTO notifications (user_id, case_id, kind, message) VALUES ($1, $2, $3, $4) RETURNING id", [
		userId,
		caseId,
		kind,
		message
	]);
	scheduleDelivery(rows[0].id);
}

// Avisa quem criou e quem esta responsavel, exceto o proprio autor da acao.
async function notifyCaseParticipants(item, actorId, kind, message, executor = database) {
	const recipients = new Set([item.assigned_to, item.created_by].filter((id) => id && id !== actorId));
	for (const userId of recipients) await notifyUser(userId, item.id, kind, message, executor);
}

async function listNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
	const { rows } = await database.query(
		`SELECT n.id, n.case_id AS "caseId", c.case_number AS "caseNumber", n.kind, n.message, n.read_at AS "readAt", n.created_at AS "createdAt"
		 FROM notifications n LEFT JOIN cases c ON c.id = n.case_id
		 WHERE n.user_id = $1 ${unreadOnly ? "AND n.read_at IS NULL" : ""}
		 ORDER BY n.created_at DESC LIMIT $2`,
		[userId, limit]
	);
	const { rows: counts } = await database.query("SELECT COUNT(*)::int AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL", [userId]);
	return { notifications: rows, unread: counts[0].unread };
}

async function markRead(userId, id) {
	await database.query("UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL", [id, userId]);
}

async function markAllRead(userId) {
	await database.query("UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL", [userId]);
}

module.exports = { notifyUser, notifyCaseParticipants, listNotifications, markRead, markAllRead, idle, KIND_TITLES };
