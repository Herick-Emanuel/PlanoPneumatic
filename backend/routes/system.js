const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { database } = require("../db");
const constants = require("../domain/constants");
const { capabilities, permissionMatrix } = require("../domain/permissions");
const { transitions } = require("../domain/workflow");
const { requireAuth, requireCapability } = require("../middleware/auth");
const { badRequest, wrap } = require("../middleware/errors");
const { buildCaseFilters, likeTerm } = require("../services/caseFilters");
const { formatCase } = require("../services/cases");
const notifications = require("../services/notifications");
const settings = require("../services/settings");
const sla = require("../services/sla");
const { WEBHOOK_EVENTS } = require("../services/webhooks");
const reports = require("../services/reports");

const router = express.Router();

// Tabela unica de tipos, status, rotulos e transicoes, consumida pelo frontend.
router.get("/meta", (request, response) => response.json({
	caseTypes: constants.CASE_TYPES,
	statuses: constants.STATUSES.map((code) => ({ code, label: constants.STATUS_LABELS[code] })),
	finishedStatuses: constants.FINISHED_STATUSES,
	transitions,
	roles: constants.ROLE_LABELS,
	attachmentKinds: constants.ATTACHMENT_KINDS,
	warrantyDestinations: constants.WARRANTY_DESTINATIONS,
	logisticsStatuses: constants.LOGISTICS_STATUSES,
	exchangeReasons: constants.EXCHANGE_REASONS,
	itemConditions: constants.ITEM_CONDITIONS,
	riskLevels: constants.RISK_LEVELS,
	webhookEvents: WEBHOOK_EVENTS
}));

router.use(requireAuth);

router.get("/me/capabilities", (request, response) => response.json({ capabilities: permissionMatrix[request.user.role] || [] }));

router.get("/dashboard/summary", wrap(async (request, response) => {
	const { listQuerySchema } = require("../validators/cases");
	const query = listQuerySchema.omit({ sort: true, direction: true, page: true, pageSize: true }).parse(request.query);
	return response.json(await reports.dashboardSummary(request.user, query));
}));
router.get("/pending", wrap(async (request, response) => response.json({ items: await reports.pendingItems(request.user) })));

router.get("/settings", wrap(async (request, response) => response.json({ settings: await settings.getAll(), sla: await sla.listSla() })));
router.put("/settings/:key", requireCapability(capabilities.MANAGE_SETTINGS), wrap(async (request, response) => {
	const { value } = z.object({ value: z.boolean() }).parse(request.body);
	if (!(await settings.set(request.params.key, value, request.user.id))) throw badRequest("Configuracao desconhecida.");
	return response.json({ key: request.params.key, value });
}));

router.get("/sla", wrap(async (request, response) => response.json({ sla: await sla.listSla() })));
router.put("/sla/:type", requireCapability(capabilities.MANAGE_SETTINGS), wrap(async (request, response) => {
	const type = String(request.params.type);
	const days = Number(request.body.days);
	if (!constants.CASE_TYPES.includes(type) || !Number.isInteger(days) || days < 1 || days > 365) throw badRequest("Informe um SLA valido entre 1 e 365 dias.");
	const { rows } = await database.query("INSERT INTO case_sla_config (type, days, updated_by) VALUES ($1, $2, $3) ON CONFLICT (type) DO UPDATE SET days = EXCLUDED.days, updated_by = EXCLUDED.updated_by, updated_at = NOW() RETURNING type, days, updated_at AS \"updatedAt\"", [type, days, request.user.id]);
	return response.json({ sla: rows[0] });
}));

router.get("/notifications", wrap(async (request, response) => response.json(await notifications.listNotifications(request.user.id, { unreadOnly: request.query.unread === "true" }))));
router.post("/notifications/read-all", wrap(async (request, response) => { await notifications.markAllRead(request.user.id); return response.status(204).send(); }));
router.patch("/notifications/:id/read", wrap(async (request, response) => { await notifications.markRead(request.user.id, Number(request.params.id)); return response.status(204).send(); }));

router.get("/integrations/webhooks", requireCapability(capabilities.MANAGE_INTEGRATIONS), wrap(async (request, response) => {
	const { rows } = await database.query("SELECT id, name, endpoint_url AS \"endpointUrl\", events, active, created_at AS \"createdAt\" FROM webhooks ORDER BY created_at DESC");
	return response.json({ webhooks: rows });
}));
router.post("/integrations/webhooks", requireCapability(capabilities.MANAGE_INTEGRATIONS), wrap(async (request, response) => {
	const name = String(request.body.name || "").trim();
	const endpointUrl = String(request.body.endpointUrl || "").trim();
	const secret = String(request.body.secret || "").trim();
	const events = Array.isArray(request.body.events) ? request.body.events.filter((event) => WEBHOOK_EVENTS.includes(event)) : [];
	if (!name || !secret || !/^https:\/\//i.test(endpointUrl) || !events.length) throw badRequest("Informe nome, endpoint HTTPS, segredo e ao menos um evento.");
	const { rows } = await database.query("INSERT INTO webhooks (name, endpoint_url, secret, events, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, endpoint_url AS \"endpointUrl\", events, active, created_at AS \"createdAt\"", [name, endpointUrl, secret, JSON.stringify(events), request.user.id]);
	return response.status(201).json({ webhook: rows[0] });
}));
router.patch("/integrations/webhooks/:id", requireCapability(capabilities.MANAGE_INTEGRATIONS), wrap(async (request, response) => {
	const { active } = z.object({ active: z.boolean() }).parse(request.body);
	const { rows } = await database.query("UPDATE webhooks SET active = $1 WHERE id = $2 RETURNING id, name, endpoint_url AS \"endpointUrl\", events, active", [active, Number(request.params.id)]);
	if (!rows[0]) return response.status(404).json({ message: "Webhook nao encontrado." });
	return response.json({ webhook: rows[0] });
}));
router.get("/integrations/webhooks/:id/deliveries", requireCapability(capabilities.MANAGE_INTEGRATIONS), wrap(async (request, response) => {
	const { rows } = await database.query("SELECT id, event, attempt, status_code AS \"statusCode\", success, error, created_at AS \"createdAt\" FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100", [Number(request.params.id)]);
	return response.json({ deliveries: rows });
}));

router.get("/search", wrap(async (request, response) => {
	const term = String(request.query.q || "").trim();
	if (!term) return response.json({ cases: [] });
	const { where, values } = buildCaseFilters(request.user, {});
	const parameter = `$${values.length + 1}`;
	const { rows } = await database.query(
		`SELECT c.* FROM cases c WHERE ${where} AND (c.case_number ILIKE ${parameter} OR c.client ILIKE ${parameter} OR c.product ILIKE ${parameter} OR c.product_code ILIKE ${parameter} OR c.document_reference ILIKE ${parameter} OR c.serial_number ILIKE ${parameter} OR c.lot_number ILIKE ${parameter}) ORDER BY c.updated_at DESC LIMIT 20`,
		[...values, likeTerm(term)]
	);
	return response.json({ cases: rows.map(formatCase) });
}));

router.get("/filters", wrap(async (request, response) => {
	const { rows } = await database.query("SELECT id, name, filters FROM saved_filters WHERE user_id = $1 ORDER BY name", [request.user.id]);
	return response.json({ filters: rows });
}));
router.post("/filters", wrap(async (request, response) => {
	const data = z.object({ name: z.string().trim().min(1).max(80), filters: z.record(z.string(), z.string().max(200)).default({}) }).parse(request.body);
	const { rows } = await database.query("INSERT INTO saved_filters (user_id, name, filters) VALUES ($1, $2, $3) ON CONFLICT (user_id, name) DO UPDATE SET filters = EXCLUDED.filters RETURNING id, name, filters", [request.user.id, data.name, JSON.stringify(data.filters)]);
	return response.status(201).json({ filter: rows[0] });
}));
router.delete("/filters/:id", wrap(async (request, response) => {
	await database.query("DELETE FROM saved_filters WHERE id = $1 AND user_id = $2", [Number(request.params.id), request.user.id]);
	return response.status(204).send();
}));

router.post("/activity", wrap(async (request, response) => {
	const action = String(request.body.action || "").trim();
	if (!["navigation", "click"].includes(action)) throw badRequest("Acao invalida.");
	const path = String(request.body.path || "").slice(0, 200) || null;
	const label = String(request.body.label || "").slice(0, 200) || null;
	await database.query("INSERT INTO user_activity_log (user_id, action, path, label) VALUES ($1, $2, $3, $4)", [request.user.id, action, path, label]);
	return response.status(204).send();
}));

router.patch("/account", wrap(async (request, response) => {
	const name = String(request.body.name || "").trim();
	const password = String(request.body.password || "");
	if (!name) throw badRequest("Informe seu nome.");
	if (password) await database.query("UPDATE users SET name = $1, password_hash = $2 WHERE id = $3", [name, await bcrypt.hash(password, 12), request.user.id]);
	else await database.query("UPDATE users SET name = $1 WHERE id = $2", [name, request.user.id]);
	const { rows } = await database.query("SELECT id, name, email, role FROM users WHERE id = $1", [request.user.id]);
	return response.json({ user: rows[0] });
}));

module.exports = { router };
