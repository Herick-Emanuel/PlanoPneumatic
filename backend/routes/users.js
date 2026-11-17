const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { database, withTransaction } = require("../db");
const { roles, ROLE_LABELS, FINISHED_STATUSES } = require("../domain/constants");
const { capabilities, can } = require("../domain/permissions");
const { requireAuth, requireCapability } = require("../middleware/auth");
const { badRequest, conflict, forbidden, notFound, wrap } = require("../middleware/errors");
const { notifyUser } = require("../services/notifications");
const { addEvent } = require("../services/cases");
const crypto = require("node:crypto");
const mailer = require("../services/mailer");
const { issueToken } = require("./auth");

// F13: convite com link de primeiro acesso (72 h). A senha e escolhida pela propria pessoa.
async function sendInvite(user, invitedBy) {
	const token = await issueToken(user.id, "invite");
	await mailer.send({
		to: user.email,
		subject: "Convite para o PlanoPneumatic",
		title: "Você foi convidado para o PlanoPneumatic",
		lines: [`Olá, ${user.name.split(" ")[0]}.`, `${invitedBy} criou o seu acesso ao sistema de pedidos, trocas e garantias.`, "Defina a sua senha pelo link abaixo. Ele vale por 72 horas e só pode ser usado uma vez."],
		action: { label: "Criar minha senha", url: mailer.appUrl(`/?convite=${token}`) }
	});
	return token;
}

const router = express.Router();
router.use(requireAuth);

const USER_FIELDS = "id, name, email, role, active, manager_id AS \"managerId\", created_at AS \"createdAt\"";
const ALL_ROLES = Object.values(roles);

async function auditUserChange(executor, actorId, targetUserId, action, details = {}) {
	await executor.query("INSERT INTO user_audit_log (actor_id, target_user_id, action, details) VALUES ($1, $2, $3, $4)", [actorId, targetUserId, action, JSON.stringify(details)]);
}

router.get("/", requireCapability(capabilities.VIEW_USERS), wrap(async (request, response) => {
	const { rows } = await database.query("SELECT u.id, u.name, u.email, u.role, u.active, u.created_at AS \"createdAt\", u.manager_id AS \"managerId\", mgr.name AS \"managerName\" FROM users u LEFT JOIN users mgr ON mgr.id = u.manager_id ORDER BY u.name");
	return response.json({ users: rows, roles: ROLE_LABELS });
}));

// Lista enxuta para selecionar responsaveis (qualquer usuario autenticado com permissao de atribuir).
router.get("/assignable", requireCapability(capabilities.ASSIGN_CASES), wrap(async (request, response) => {
	const { rows } = await database.query("SELECT id, name, role FROM users WHERE active = TRUE AND role IN ('operator', 'technician', 'logistics') ORDER BY name");
	return response.json({ users: rows });
}));

router.post("/", requireCapability(capabilities.CREATE_OPERATOR), wrap(async (request, response) => {
	const name = String(request.body.name || "").trim();
	const email = String(request.body.email || "").trim().toLowerCase();
	const invite = request.body.invite === true;
	const password = invite ? crypto.randomBytes(24).toString("base64url") : String(request.body.password || "");
	const role = String(request.body.role || "operator").trim();
	const allowedRoles = can(request.user, capabilities.CREATE_ANY_ROLE) ? ALL_ROLES.filter((value) => value !== roles.ADMIN) : [roles.OPERATOR];
	if (!name || !email || password.length < 8 || !allowedRoles.includes(role)) throw badRequest(invite ? "Informe nome, e-mail e um perfil permitido." : "Informe nome, e-mail, senha com pelo menos 8 caracteres e um perfil permitido.");
	let managerId = null;
	if (request.user.role === roles.MANAGER) {
		managerId = role === roles.OPERATOR ? request.user.id : null;
	} else if (can(request.user, capabilities.TRANSFER_TEAM) && request.body.managerId) {
		const parsedManagerId = Number(request.body.managerId);
		if (Number.isInteger(parsedManagerId)) {
			const { rows } = await database.query("SELECT id FROM users WHERE id = $1 AND role = 'manager' AND active = TRUE", [parsedManagerId]);
			if (rows[0]) managerId = parsedManagerId;
		}
	}
	try {
		const created = await withTransaction(async (db) => {
			const { rows } = await db.query(`INSERT INTO users (name, email, password_hash, role, manager_id) VALUES ($1, $2, $3, $4, $5) RETURNING ${USER_FIELDS}`, [name, email, await bcrypt.hash(password, 12), role, managerId]);
			await auditUserChange(db, request.user.id, rows[0].id, "USER_CREATED", { role, managerId, invite });
			return rows[0];
		});
		if (invite) await sendInvite(created, request.user.name);
		return response.status(201).json({ user: created, invited: invite, mailConfigured: mailer.isConfigured() });
	} catch (error) {
		if (error.code === "23505") throw conflict("Ja existe uma conta com este e-mail.", "DUPLICATE_EMAIL");
		throw error;
	}
}));

router.get("/audit", requireCapability(capabilities.VIEW_AUDIT), wrap(async (request, response) => {
	const { rows } = await database.query("SELECT audit.id, audit.action, audit.details, audit.created_at AS \"createdAt\", actor.name AS \"actorName\", target.name AS \"targetName\" FROM user_audit_log audit LEFT JOIN users actor ON actor.id = audit.actor_id LEFT JOIN users target ON target.id = audit.target_user_id ORDER BY audit.created_at DESC LIMIT 200");
	return response.json({ audit: rows });
}));

router.patch("/:userId/team", requireCapability(capabilities.TRANSFER_TEAM), wrap(async (request, response) => {
	const targetUserId = Number(request.params.userId);
	if (!Number.isInteger(targetUserId)) throw badRequest("Usuario alvo invalido.");
	const raw = request.body.managerId;
	const managerId = raw === null || raw === "" || raw === undefined ? null : Number(raw);
	if (managerId !== null) {
		if (!Number.isInteger(managerId) || managerId === targetUserId) throw badRequest("Gerente invalido.");
		const { rows } = await database.query("SELECT id FROM users WHERE id = $1 AND role = 'manager' AND active = TRUE", [managerId]);
		if (!rows[0]) throw badRequest("Selecione um gerente ativo valido.");
	}
	const { rows } = await database.query(`UPDATE users SET manager_id = $1 WHERE id = $2 RETURNING ${USER_FIELDS}`, [managerId, targetUserId]);
	if (!rows[0]) throw notFound("Usuario nao encontrado.");
	await auditUserChange(database, request.user.id, targetUserId, "TEAM_TRANSFERRED", { managerId });
	return response.json({ user: rows[0] });
}));

// Reatribui os processos abertos de um usuario desativado: ao gerente do time ou, na falta, a quem desativou.
async function reassignOpenCases(db, target, actor, explicitAssigneeId) {
	let fallbackId = explicitAssigneeId || target.manager_id || actor.id;
	const { rows: assigneeRows } = await db.query("SELECT id, name FROM users WHERE id = $1 AND active = TRUE AND id <> $2", [fallbackId, target.id]);
	if (!assigneeRows[0]) { fallbackId = actor.id; assigneeRows[0] = { id: actor.id, name: actor.name }; }
	const finished = FINISHED_STATUSES.map((status) => `'${status}'`).join(", ");
	const { rows: cases } = await db.query(`UPDATE cases SET assigned_to = $1, responsible = $2, updated_at = NOW() WHERE assigned_to = $3 AND archived_at IS NULL AND status NOT IN (${finished}) RETURNING id, case_number`, [assigneeRows[0].id, assigneeRows[0].name, target.id]);
	for (const item of cases) {
		await addEvent(db, item.id, "ATRIBUICAO", `Processo reatribuido para ${assigneeRows[0].name} (usuario ${target.name} desativado)`, actor);
		await notifyUser(assigneeRows[0].id, item.id, "CASE_ASSIGNED", `O processo ${item.case_number} foi atribuido a voce (reatribuicao automatica).`, db);
	}
	return { reassigned: cases.length, assigneeId: assigneeRows[0].id };
}

router.patch("/:userId/status", requireCapability(capabilities.MANAGE_USER_STATUS), wrap(async (request, response) => {
	const targetUserId = Number(request.params.userId);
	const active = request.body.active === true;
	if (!Number.isInteger(targetUserId) || targetUserId === request.user.id) throw badRequest("Usuario alvo invalido.");
	const result = await withTransaction(async (db) => {
		const { rows } = await db.query(`UPDATE users SET active = $1 WHERE id = $2 RETURNING ${USER_FIELDS}, manager_id`, [active, targetUserId]);
		if (!rows[0]) throw notFound("Usuario nao encontrado.");
		let reassignment = { reassigned: 0 };
		if (!active) {
			await db.query("DELETE FROM sessions WHERE user_id = $1", [targetUserId]);
			reassignment = await reassignOpenCases(db, rows[0], request.user, Number(request.body.reassignTo) || null);
		}
		await auditUserChange(db, request.user.id, targetUserId, active ? "USER_ACTIVATED" : "USER_DEACTIVATED", { active, ...reassignment });
		return { user: rows[0], reassignment };
	});
	return response.json(result);
}));

// F13: editar nome, e-mail e perfil (somente administrador).
router.patch("/:userId", requireCapability(capabilities.EDIT_USER), wrap(async (request, response) => {
	if (!can(request.user, capabilities.CREATE_ANY_ROLE)) throw forbidden();
	const targetUserId = Number(request.params.userId);
	const data = z.object({
		name: z.string().trim().min(1).max(120).optional(),
		email: z.string().trim().toLowerCase().email("E-mail invalido.").max(180).optional(),
		role: z.enum(ALL_ROLES).optional()
	}).parse(request.body);
	if (!Number.isInteger(targetUserId)) throw badRequest("Usuario alvo invalido.");
	if (data.role && targetUserId === request.user.id) throw badRequest("Voce nao pode alterar o proprio perfil.");
	const sets = Object.keys(data).map((key, index) => `${key} = $${index + 1}`);
	if (!sets.length) throw badRequest("Informe algum dado para alterar.");
	try {
		const updated = await withTransaction(async (db) => {
			const { rows } = await db.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${sets.length + 1} RETURNING ${USER_FIELDS}`, [...Object.values(data), targetUserId]);
			if (!rows[0]) throw notFound("Usuario nao encontrado.");
			await auditUserChange(db, request.user.id, targetUserId, "USER_UPDATED", data);
			if (data.role) await db.query("DELETE FROM sessions WHERE user_id = $1", [targetUserId]);
			return rows[0];
		});
		return response.json({ user: updated });
	} catch (error) {
		if (error.code === "23505") throw conflict("Ja existe uma conta com este e-mail.", "DUPLICATE_EMAIL");
		throw error;
	}
}));

// F13: redefinicao de senha pelo administrador (encerra as sessoes do usuario).
router.post("/:userId/reset-password", requireCapability(capabilities.EDIT_USER), wrap(async (request, response) => {
	if (!can(request.user, capabilities.CREATE_ANY_ROLE)) throw forbidden();
	const targetUserId = Number(request.params.userId);
	const password = String(request.body.password || "");
	if (!Number.isInteger(targetUserId) || password.length < 8) throw badRequest("Informe uma senha com pelo menos 8 caracteres.");
	await withTransaction(async (db) => {
		const { rows } = await db.query("UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id", [await bcrypt.hash(password, 12), targetUserId]);
		if (!rows[0]) throw notFound("Usuario nao encontrado.");
		await db.query("DELETE FROM sessions WHERE user_id = $1", [targetUserId]);
		await auditUserChange(db, request.user.id, targetUserId, "PASSWORD_RESET", {});
	});
	return response.status(204).send();
}));

// Reenvia o convite (por exemplo, quando o link expirou).
router.post("/:userId/invite", requireCapability(capabilities.CREATE_OPERATOR), wrap(async (request, response) => {
	const { rows } = await database.query(`SELECT ${USER_FIELDS} FROM users WHERE id = $1 AND active = TRUE`, [Number(request.params.userId)]);
	if (!rows[0]) throw notFound("Usuario nao encontrado.");
	if (request.user.role === roles.MANAGER && rows[0].managerId !== request.user.id) throw forbidden("Gerentes reenviam convite so para o proprio time.");
	await sendInvite(rows[0], request.user.name);
	await auditUserChange(database, request.user.id, rows[0].id, "INVITE_SENT", {});
	return response.json({ invited: true, mailConfigured: mailer.isConfigured() });
}));

module.exports = { router };
