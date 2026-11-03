const express = require("express");
const { z } = require("zod");
const { database } = require("../db");
const { config } = require("../config");
const { FINISHED_STATUSES } = require("../domain/constants");
const { capabilities, can } = require("../domain/permissions");
const { requireAuth, requireCapability } = require("../middleware/auth");
const { AppError, badRequest, forbidden, wrap } = require("../middleware/errors");
const schemas = require("../validators/cases");
const cases = require("../services/cases");
const attachments = require("../services/attachments");

const router = express.Router();
router.use(requireAuth);

const caseParam = (request) => String(request.params.caseNumber);

router.get("/", wrap(async (request, response) => {
	const query = schemas.listQuerySchema.parse(request.query);
	return response.json(await cases.listCases(request.user, query));
}));

router.post("/", wrap(async (request, response) => {
	const data = schemas.createCaseSchema.parse(request.body);
	const created = await cases.createCase(request.user, data);
	return response.status(201).json({ case: cases.formatCase(created) });
}));

router.post("/import", requireCapability(capabilities.IMPORT_CASES), wrap(async (request, response) => {
	const items = Array.isArray(request.body.items) ? request.body.items : [];
	if (!items.length || items.length > 500) throw badRequest("Envie entre 1 e 500 pedidos.");
	const results = [];
	for (let index = 0; index < items.length; index += 1) {
		const parsed = schemas.createCaseSchema.safeParse(items[index]);
		if (!parsed.success) {
			results.push({ line: index + 1, status: "error", message: parsed.error.issues[0]?.message || "Dados invalidos." });
			continue;
		}
		try {
			const created = await cases.createCase(request.user, parsed.data);
			results.push({ line: index + 1, status: "created", id: created.case_number });
		} catch (error) {
			if (!(error instanceof AppError)) throw error;
			results.push({ line: index + 1, status: "error", message: error.message });
		}
	}
	return response.status(201).json({ total: items.length, created: results.filter((entry) => entry.status === "created").length, errors: results.filter((entry) => entry.status === "error").length, results });
}));

router.post("/bulk/assign", requireCapability(capabilities.ASSIGN_CASES), wrap(async (request, response) => {
	const { caseNumbers, assignedTo } = z.object({ caseNumbers: z.array(z.string().min(1)).min(1).max(200), assignedTo: z.coerce.number().int().positive() }).parse(request.body);
	const results = [];
	for (const caseNumber of caseNumbers) {
		try {
			await cases.assignCase(request.user, caseNumber, assignedTo);
			results.push({ id: caseNumber, status: "assigned" });
		} catch (error) {
			if (!(error instanceof AppError)) throw error;
			results.push({ id: caseNumber, status: "error", message: error.message });
		}
	}
	return response.json({ results, assigned: results.filter((entry) => entry.status === "assigned").length });
}));

router.get("/:caseNumber", wrap(async (request, response) => response.json({ case: await cases.getCaseDetail(request.user, caseParam(request)) })));

router.patch("/:caseNumber", wrap(async (request, response) => {
	const data = schemas.updateCaseSchema.parse(request.body);
	await cases.updateCase(request.user, caseParam(request), data, request.body);
	return response.json({ case: await cases.getCaseDetail(request.user, caseParam(request)) });
}));

router.patch("/:caseNumber/status", wrap(async (request, response) => {
	const data = schemas.statusSchema.parse(request.body);
	const updated = await cases.changeStatus(request.user, caseParam(request), data);
	return response.json({ case: cases.formatCase(updated) });
}));

router.patch("/:caseNumber/assignee", requireCapability(capabilities.ASSIGN_CASES), wrap(async (request, response) => {
	const assigneeId = Number(request.body.assignedTo);
	if (!Number.isInteger(assigneeId)) throw badRequest("Informe um operador valido.");
	return response.json({ case: cases.formatCase(await cases.assignCase(request.user, caseParam(request), assigneeId)) });
}));

router.post("/:caseNumber/archive", wrap(async (request, response) => response.json({ case: cases.formatCase(await cases.setArchived(request.user, caseParam(request), true)) })));
router.post("/:caseNumber/unarchive", wrap(async (request, response) => response.json({ case: cases.formatCase(await cases.setArchived(request.user, caseParam(request), false)) })));

router.get("/:caseNumber/timeline", wrap(async (request, response) => {
	const detail = await cases.getCaseDetail(request.user, caseParam(request));
	return response.json({ timeline: detail.events });
}));

router.get("/:caseNumber/comments", wrap(async (request, response) => {
	const item = await cases.findCase(caseParam(request), request.user);
	const { rows } = await database.query("SELECT c.id, c.body, c.created_at AS \"createdAt\", u.name AS \"authorName\" FROM case_comments c JOIN users u ON u.id = c.author_id WHERE c.case_id = $1 ORDER BY c.created_at DESC", [item.id]);
	return response.json({ comments: rows });
}));

router.post("/:caseNumber/comments", wrap(async (request, response) => {
	if (!can(request.user, capabilities.EDIT_CASE)) throw forbidden();
	const { body } = z.object({ body: z.string().trim().min(1, "Informe um comentario.").max(4000) }).parse({ body: request.body.body });
	const item = await cases.findCase(caseParam(request), request.user);
	const { rows } = await database.query("INSERT INTO case_comments (case_id, author_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at AS \"createdAt\"", [item.id, request.user.id, body]);
	await cases.addEvent(database, item.id, "COMENTARIO", "Comentario interno adicionado", request.user);
	return response.status(201).json({ comment: { ...rows[0], authorName: request.user.name } });
}));

router.patch("/:caseNumber/checklist/:itemId", wrap(async (request, response) => {
	if (!can(request.user, capabilities.EDIT_CASE)) throw forbidden();
	const item = await cases.findCase(caseParam(request), request.user, { includeArchived: false });
	if (FINISHED_STATUSES.includes(item.status)) throw new AppError(422, "Processo finalizado: reabra para alterar o checklist.", "CASE_LOCKED");
	const completed = request.body.completed === true;
	const { rows } = await database.query("UPDATE case_checklist_items SET completed = $1, completed_by = $2, completed_at = CASE WHEN $1 THEN NOW() ELSE NULL END WHERE id = $3 AND case_id = $4 RETURNING *", [completed, completed ? request.user.id : null, Number(request.params.itemId), item.id]);
	if (!rows[0]) throw new AppError(404, "Item de checklist nao encontrado.", "NOT_FOUND");
	await cases.addEvent(database, item.id, "CHECKLIST", `${completed ? "Concluido" : "Reaberto"}: ${rows[0].label}`, request.user);
	return response.json({ item: rows[0] });
}));

// Compatibilidade com a tela de historico: checklist + anexos.
router.get("/:caseNumber/management", wrap(async (request, response) => {
	const detail = await cases.getCaseDetail(request.user, caseParam(request));
	return response.json({ checklist: detail.checklist, attachments: detail.attachments });
}));

router.get("/:caseNumber/attachments", wrap(async (request, response) => response.json({ attachments: await attachments.listAttachments(request.user, caseParam(request)) })));

router.post("/:caseNumber/attachments", wrap(async (request, response) => {
	const meta = schemas.attachmentMetaSchema.parse({ kind: request.body.kind, stage: request.body.stage });
	const created = await attachments.addLink(request.user, caseParam(request), { fileName: String(request.body.fileName || "").trim(), fileUrl: String(request.body.fileUrl || "").trim(), ...meta });
	return response.status(201).json({ attachment: created });
}));

router.post("/:caseNumber/attachments/upload", express.raw({ type: () => true, limit: config.maxAttachmentBytes + 1024 }), wrap(async (request, response) => {
	const meta = schemas.attachmentMetaSchema.parse({ kind: request.query.kind, stage: request.query.stage });
	let fileName = "arquivo";
	try { fileName = decodeURIComponent(request.get("x-file-name") || "arquivo"); } catch { /* nome invalido: usa o padrao */ }
	const created = await attachments.addUpload(request.user, caseParam(request), { buffer: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0), fileName, ...meta });
	return response.status(201).json({ attachment: created });
}));

router.get("/:caseNumber/attachments/:attachmentId/file", wrap(async (request, response) => {
	const file = await attachments.getFile(request.user, caseParam(request), Number(request.params.attachmentId));
	response.setHeader("Content-Type", file.mime_type);
	response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.file_name)}`);
	response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
	response.setHeader("Cache-Control", "private, max-age=300");
	return response.send(file.content);
}));

router.delete("/:caseNumber/attachments/:attachmentId", wrap(async (request, response) => {
	await attachments.removeAttachment(request.user, caseParam(request), Number(request.params.attachmentId));
	return response.status(204).send();
}));

module.exports = { router };
