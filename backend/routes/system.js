const express = require("express");
const { z } = require("zod");
const { database } = require("../db");
const constants = require("../domain/constants");
const { capabilities, permissionMatrix, can } = require("../domain/permissions");
const { transitions } = require("../domain/workflow");
const { requireAuth, requireCapability } = require("../middleware/auth");
const { rateLimit } = require("../middleware/security");
const { badRequest, forbidden, wrap } = require("../middleware/errors");
const { buildCaseFilters, likeTerm } = require("../services/caseFilters");
const { formatCase } = require("../services/cases");
const notifications = require("../services/notifications");
const settings = require("../services/settings");
const sla = require("../services/sla");
const { WEBHOOK_EVENTS, validateEndpoint, resolvesToPrivate } = require("../services/webhooks");
const { audit, AUDIT_ACTIONS } = require("../services/audit");
const accounts = require("../services/accounts");
const { encrypt } = require("../security/crypto");
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
	const key = String(request.params.key);
	// Configuracoes de seguranca (escopo do gerente, MFA obrigatorio, monitoramento): so o administrador altera.
	if (settings.SECURITY_SETTINGS.includes(key) && !can(request.user, capabilities.CREATE_ANY_ROLE)) throw forbidden("Somente o administrador altera configuracoes de seguranca.");
	if (!(await settings.set(key, value, request.user.id))) throw badRequest("Configuracao desconhecida.");
	await audit("SETTING_CHANGED", { actorId: request.user.id, entityType: "setting", entityId: key, details: { value } });
	return response.json({ key, value });
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
	const events = Array.isArray(request.body.events) ? [...new Set(request.body.events.filter((event) => WEBHOOK_EVENTS.includes(event)))] : [];
	if (!name || !secret || !events.length) throw badRequest("Informe nome, endpoint HTTPS, segredo e ao menos um evento.");
	if (name.length > 120 || endpointUrl.length > 500) throw badRequest("Nome ou endpoint muito longo.");
	if (secret.length < 16) throw badRequest("Use um segredo de assinatura com pelo menos 16 caracteres.");
	const problem = validateEndpoint(endpointUrl);
	if (problem) throw badRequest(problem, "WEBHOOK_ENDPOINT_INVALID");
	// P1 (SSRF): recusa ja na criacao se o nome resolve para endereco interno; a entrega confere de novo.
	if (await resolvesToPrivate(new URL(endpointUrl).hostname)) throw badRequest("Endpoint resolve para um endereco interno e foi bloqueado.", "WEBHOOK_ENDPOINT_INVALID");
	// O segredo fica cifrado no banco (AES-256-GCM, chave APP_ENCRYPTION_KEY) e nunca volta pela API.
	const { rows } = await database.query("INSERT INTO webhooks (name, endpoint_url, secret, events, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, endpoint_url AS \"endpointUrl\", events, active, created_at AS \"createdAt\"", [name, endpointUrl, encrypt(secret), JSON.stringify(events), request.user.id]);
	await audit("WEBHOOK_CREATED", { actorId: request.user.id, entityType: "webhook", entityId: rows[0].id, details: { name, endpointUrl, events } });
	return response.status(201).json({ webhook: rows[0] });
}));
router.patch("/integrations/webhooks/:id", requireCapability(capabilities.MANAGE_INTEGRATIONS), wrap(async (request, response) => {
	const { active } = z.object({ active: z.boolean() }).parse(request.body);
	const { rows } = await database.query("UPDATE webhooks SET active = $1 WHERE id = $2 RETURNING id, name, endpoint_url AS \"endpointUrl\", events, active", [active, Number(request.params.id)]);
	if (!rows[0]) return response.status(404).json({ message: "Webhook nao encontrado." });
	await audit("WEBHOOK_UPDATED", { actorId: request.user.id, entityType: "webhook", entityId: rows[0].id, details: { active } });
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

// Monitoramento de uso (revisado para a LGPD): so registra a tela visitada (caminho, sem parametros) e o
// nome de botoes marcados com data-track; nunca o texto livre de links (que pode ter nome de cliente).
// Pode ser desligado pelo administrador (activity_tracking) e e apagado apos ACTIVITY_RETENTION_DAYS.
router.post("/activity", wrap(async (request, response) => {
	const action = String(request.body.action || "").trim();
	if (!["navigation", "click"].includes(action)) throw badRequest("Acao invalida.");
	if (!(await settings.get("activity_tracking", true))) return response.status(204).send();
	const path = String(request.body.path || "").split(/[?#]/)[0].slice(0, 200);
	if (!/^\/[\w\-./]*$/.test(path)) throw badRequest("Caminho invalido.");
	const label = action === "click" ? String(request.body.label || "").replace(/[^\w\- .]/g, "").slice(0, 60) || null : null;
	await database.query("INSERT INTO user_activity_log (user_id, action, path, label) VALUES ($1, $2, $3, $4)", [request.user.id, action, path, label]);
	return response.status(204).send();
}));

router.patch("/account", rateLimit({ windowMs: 15 * 60 * 1000, max: 15, name: "account-sensitive" }), wrap(async (request, response) => {
	const name = String(request.body.name || "").trim();
	const password = String(request.body.password || "");
	if (!name || name.length > 120) throw badRequest("Informe seu nome.");
	// P1: troca de senha por aqui tambem exige a senha atual e encerra as outras sessoes.
	if (password) await accounts.changePassword(request.user, request.session.id, { currentPassword: request.body.currentPassword, newPassword: password });
	await database.query("UPDATE users SET name = $1 WHERE id = $2", [name, request.user.id]);
	const { rows } = await database.query("SELECT id, name, email, role FROM users WHERE id = $1", [request.user.id]);
	return response.json({ user: rows[0] });
}));

// Auditoria geral (P2): filtros por acao, usuario, entidade (ex.: processo) e periodo.
const auditQuerySchema = z.object({
	action: z.string().max(60).optional(),
	actorId: z.coerce.number().int().positive().optional(),
	entityType: z.enum(["user", "case", "login", "setting", "webhook"]).optional(),
	entityId: z.string().max(80).optional(),
	caseNumber: z.string().max(40).optional(),
	from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	limit: z.coerce.number().int().min(1).max(500).default(200)
});
router.get("/audit", requireCapability(capabilities.VIEW_AUDIT), wrap(async (request, response) => {
	const query = auditQuerySchema.parse(request.query);
	const clauses = [];
	const values = [];
	const add = (sql, value) => { values.push(value); clauses.push(sql.replaceAll("$V", `$${values.length}`)); };
	if (query.action) add("a.action = $V", query.action);
	if (query.actorId) add("a.actor_id = $V", query.actorId);
	if (query.entityType) add("a.entity_type = $V", query.entityType);
	if (query.entityId) add("a.entity_id = $V", query.entityId);
	if (query.caseNumber) add("a.entity_type = 'case' AND c.case_number = $V", query.caseNumber.trim().toUpperCase());
	if (query.from) add("(a.created_at AT TIME ZONE 'America/Sao_Paulo')::date >= $V::date", query.from);
	if (query.to) add("(a.created_at AT TIME ZONE 'America/Sao_Paulo')::date <= $V::date", query.to);
	// Gerente ve so a auditoria envolvendo ele e o proprio time.
	if (request.user.role === constants.roles.MANAGER) add("(a.actor_id IN (SELECT id FROM users WHERE id = $V OR manager_id = $V) OR (a.entity_type = 'user' AND a.entity_id IN (SELECT id::text FROM users WHERE id = $V OR manager_id = $V)))", request.user.id);
	values.push(query.limit);
	const { rows } = await database.query(
		`SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", c.case_number AS "caseNumber", a.ip, a.user_agent AS "userAgent",
		        a.details, a.created_at AS "createdAt", a.actor_id AS "actorId", actor.name AS "actorName", target.name AS "targetName"
		   FROM audit_log a
		   LEFT JOIN users actor ON actor.id = a.actor_id
		   LEFT JOIN users target ON a.entity_type = 'user' AND target.id::text = a.entity_id
		   LEFT JOIN cases c ON a.entity_type = 'case' AND c.id::text = a.entity_id
		  ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
		  ORDER BY a.created_at DESC, a.id DESC LIMIT $${values.length}`,
		values
	);
	return response.json({ audit: rows, actions: AUDIT_ACTIONS });
}));

module.exports = { router };
