const { database, withTransaction } = require("../db");
const { config } = require("../config");
const { can, capabilities } = require("../domain/permissions");
const { roles } = require("../domain/constants");
const { AppError, badRequest, forbidden, notFound } = require("../middleware/errors");
const { findCase, addEvent } = require("./cases");

const ATTACHMENT_FIELDS = "a.id, a.file_name AS \"fileName\", a.file_url AS \"fileUrl\", a.mime_type AS \"mimeType\", a.size_bytes AS \"sizeBytes\", a.kind, a.stage, a.created_at AS \"createdAt\", (a.content IS NOT NULL) AS \"hasFile\"";

// Tipo real do arquivo pelos primeiros bytes (nao confia no Content-Type enviado pelo cliente).
function detectMime(buffer) {
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
	return null;
}

function sanitizeFileName(name) {
	// eslint-disable-next-line no-control-regex
	const cleaned = String(name || "arquivo").replace(/[\\/\0-\x1f"<>|?*:]/g, "_").trim().slice(-170);
	return cleaned || "arquivo";
}

function canReadKind(user, kind) {
	return !(kind === "laudo" && user.role === roles.LOGISTICS);
}

async function listAttachments(user, caseNumber) {
	const item = await findCase(caseNumber, user);
	const { rows } = await database.query(`SELECT ${ATTACHMENT_FIELDS} FROM case_attachments a WHERE a.case_id = $1 AND a.removed_at IS NULL ORDER BY a.created_at DESC`, [item.id]);
	return rows.filter((row) => canReadKind(user, row.kind));
}

async function addUpload(user, caseNumber, { buffer, fileName, kind, stage }) {
	if (!can(user, capabilities.EDIT_CASE)) throw forbidden();
	if (kind === "laudo" && !can(user, capabilities.TECHNICAL_ANALYSIS)) throw forbidden("Somente tecnico, gerente ou administrador anexa laudos.");
	if (!buffer || !buffer.length) throw badRequest("Envie um arquivo.", "EMPTY_FILE");
	if (buffer.length > config.maxAttachmentBytes) throw new AppError(413, `O arquivo excede o limite de ${Math.round(config.maxAttachmentBytes / 1024 / 1024)} MB.`, "FILE_TOO_LARGE");
	const mimeType = detectMime(buffer);
	if (!mimeType) throw new AppError(415, "Tipo de arquivo nao permitido. Envie JPG, PNG, WEBP ou PDF.", "UNSUPPORTED_FILE_TYPE");
	return withTransaction(async (db) => {
		const item = await findCase(caseNumber, user, { db, lock: true, includeArchived: false });
		const safeName = sanitizeFileName(fileName);
		const { rows } = await db.query(
			"INSERT INTO case_attachments (case_id, uploaded_by, file_name, content, mime_type, size_bytes, kind, stage) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, file_name AS \"fileName\", mime_type AS \"mimeType\", size_bytes AS \"sizeBytes\", kind, stage, created_at AS \"createdAt\"",
			[item.id, user.id, safeName, buffer, mimeType, buffer.length, kind, stage || item.status]
		);
		await db.query("UPDATE cases SET updated_at = NOW() WHERE id = $1", [item.id]);
		await addEvent(db, item.id, "ANEXO", `Anexo adicionado (${kind}): ${safeName}`, user, { attachmentId: rows[0].id, kind });
		return { ...rows[0], hasFile: true };
	});
}

// Link externo (legado): somente https.
async function addLink(user, caseNumber, { fileName, fileUrl, kind, stage }) {
	if (!can(user, capabilities.EDIT_CASE)) throw forbidden();
	if (!fileName || !/^https:\/\/[^\s]+$/i.test(fileUrl || "") || fileUrl.length > 2048) throw badRequest("Informe o nome e um link https valido.", "INVALID_LINK");
	return withTransaction(async (db) => {
		const item = await findCase(caseNumber, user, { db, lock: true, includeArchived: false });
		const { rows } = await db.query(
			"INSERT INTO case_attachments (case_id, uploaded_by, file_name, file_url, kind, stage) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, file_name AS \"fileName\", file_url AS \"fileUrl\", kind, stage, created_at AS \"createdAt\"",
			[item.id, user.id, String(fileName).slice(0, 180), fileUrl, kind, stage || item.status]
		);
		await addEvent(db, item.id, "ANEXO", `Link de documento adicionado: ${rows[0].fileName}`, user, { attachmentId: rows[0].id, kind });
		return rows[0];
	});
}

async function getFile(user, caseNumber, attachmentId) {
	const item = await findCase(caseNumber, user);
	const { rows } = await database.query("SELECT file_name, content, mime_type, kind FROM case_attachments WHERE id = $1 AND case_id = $2 AND removed_at IS NULL AND content IS NOT NULL", [attachmentId, item.id]);
	const file = rows[0];
	if (!file || !canReadKind(user, file.kind)) throw notFound("Anexo nao encontrado.");
	return file;
}

async function removeAttachment(user, caseNumber, attachmentId) {
	return withTransaction(async (db) => {
		const item = await findCase(caseNumber, user, { db, lock: true, includeArchived: false });
		const { rows } = await db.query("SELECT id, uploaded_by, file_name FROM case_attachments WHERE id = $1 AND case_id = $2 AND removed_at IS NULL", [attachmentId, item.id]);
		const attachment = rows[0];
		if (!attachment) throw notFound("Anexo nao encontrado.");
		if (attachment.uploaded_by !== user.id && !can(user, capabilities.ARCHIVE_CASE)) throw forbidden("Somente quem enviou o anexo, gerente ou administrador pode remove-lo.");
		await db.query("UPDATE case_attachments SET removed_at = NOW() WHERE id = $1", [attachment.id]);
		await addEvent(db, item.id, "ANEXO", `Anexo removido: ${attachment.file_name}`, user, { attachmentId: attachment.id });
	});
}

module.exports = { detectMime, sanitizeFileName, listAttachments, addUpload, addLink, getFile, removeAttachment };
