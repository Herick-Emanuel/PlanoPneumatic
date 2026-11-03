const { database } = require("../db");

async function notifyUser(userId, caseId, kind, message, executor = database) {
	if (!userId) return;
	await executor.query("INSERT INTO notifications (user_id, case_id, kind, message) VALUES ($1, $2, $3, $4)", [userId, caseId, kind, message]);
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

module.exports = { notifyUser, notifyCaseParticipants, listNotifications, markRead, markAllRead };
