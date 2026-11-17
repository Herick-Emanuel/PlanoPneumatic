const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { database, withTransaction } = require("../db");
const { config } = require("../config");
const { permissionMatrix } = require("../domain/permissions");
const { rateLimit } = require("../middleware/security");
const {
	requireAuth,
	createSession,
	setSessionCookies,
	clearSessionCookies,
	getSessionUser,
	hashToken,
	isTrustedDevice,
	rememberDevice,
	MFA_ROLES
} = require("../middleware/auth");
const { AppError, badRequest, notFound, wrap } = require("../middleware/errors");
const { audit, currentContext } = require("../services/audit");
const throttle = require("../services/loginThrottle");
const settings = require("../services/settings");
const accounts = require("../services/accounts");
const mailer = require("../services/mailer");

const router = express.Router();

// Hash fixo usado para igualar o tempo de resposta quando o usuario nao existe (evita enumeracao por timing).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("invalid-placeholder-password", accounts.BCRYPT_ROUNDS);
const MFA_CHALLENGE_MINUTES = 5;
const MFA_CHALLENGE_ATTEMPTS = 5;

const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, name: "login" });
const sensitiveLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, name: "account-sensitive" });

// Nao grava no log o que nao parece e-mail (pode ser uma senha digitada no campo errado).
const loggableEmail = (email) => (/^[^\s@]{1,64}@[^\s@]{1,180}$/.test(email) ? email : "(valor nao parece e-mail)");

const invalidCredentials = () => new AppError(401, "Usuario ou senha invalidos.", "INVALID_CREDENTIALS");

function lockedError(seconds) {
	const minutes = Math.max(1, Math.ceil(seconds / 60));
	const error = new AppError(429, `Muitas tentativas para este usuario. Tente novamente em ${minutes} minuto(s).`, "LOGIN_LOCKED");
	error.retryAfter = seconds;
	return error;
}

function sendLocked(response, request, seconds) {
	const error = lockedError(seconds);
	response.setHeader("Retry-After", String(seconds));
	return response.status(429).json({ message: error.message, code: error.code, requestId: request.id });
}

function publicUser(user, extra = {}) {
	return { id: user.id, name: user.name, email: user.email, role: user.role, capabilities: permissionMatrix[user.role] || [], ...extra };
}

async function pendingFlags(user) {
	const allSettings = await settings.getAll();
	return {
		mustChangePassword: Boolean(user.must_change_password ?? user.mustChangePassword),
		mfaEnabled: Boolean(user.mfa_enabled_at ?? user.mfaEnabled),
		mfaEnrollmentRequired: Boolean(allSettings.mfa_required) && MFA_ROLES.includes(user.role) && !(user.mfa_enabled_at ?? user.mfaEnabled)
	};
}

// Reserva a tentativa nas duas chaves de limite (e-mail+IP sempre; so e-mail quando o aparelho nao e conhecido).
async function reserveAttempt(email, { trusted }) {
	const ip = currentContext().ip;
	const keys = [throttle.pairKey(email, ip)];
	const pair = await throttle.reserve(keys[0], email, throttle.PAIR_FREE_ATTEMPTS);
	if (!pair.allowed) return { allowed: false, retryAfter: pair.retryAfter, keys };
	let lockedNow = pair.lockedNow;
	if (!trusted) {
		keys.push(throttle.emailKey(email));
		const wide = await throttle.reserve(keys[1], email, throttle.EMAIL_FREE_ATTEMPTS);
		if (!wide.allowed) return { allowed: false, retryAfter: wide.retryAfter, keys };
		lockedNow = lockedNow || wide.lockedNow;
	}
	return { allowed: true, lockedNow, failedCount: pair.failedCount, keys };
}

async function lockSeconds(keys) {
	let seconds = 0;
	for (const key of keys) seconds = Math.max(seconds, await throttle.secondsLocked(key));
	return seconds;
}

async function completeLogin(request, response, user, { method, throttleKeys }) {
	const context = currentContext();
	const session = await withTransaction(async (db) => {
		const created = await createSession(user.id, { ip: context.ip, userAgent: context.userAgent, executor: db });
		await accounts.pruneSessions(user.id, db);
		await throttle.clear(throttleKeys, db);
		await rememberDevice(request, response, user.id, db);
		await audit("LOGIN_SUCCESS", { actorId: user.id, entityType: "user", entityId: user.id, details: { method }, executor: db });
		return created;
	});
	setSessionCookies(response, session);
	return response.json({ expiresAt: session.expiresAt, csrfToken: session.csrfToken, user: publicUser(user, await pendingFlags(user)) });
}

router.post(
	"/login",
	loginLimit,
	wrap(async (request, response) => {
		const email = throttle.normalizeEmail(request.body.email);
		const password = String(request.body.password || "");
		if (!email || !password) throw badRequest("Informe usuario e senha.");
		const { rows } = await database.query(
			"SELECT id, name, email, password_hash, role, must_change_password, mfa_enabled_at FROM users WHERE email = $1 AND active = TRUE",
			[email]
		);
		const user = rows[0];
		const attempt = await reserveAttempt(email, { trusted: user ? await isTrustedDevice(request, user.id) : false });
		if (!attempt.allowed) {
			await audit("LOGIN_LOCKED", {
				actorId: user?.id || null,
				entityType: "login",
				entityId: loggableEmail(email).slice(0, 80),
				details: { email: loggableEmail(email) }
			});
			return sendLocked(response, request, attempt.retryAfter);
		}
		const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
		if (!user || !valid) {
			await audit("LOGIN_FAILED", {
				actorId: user?.id || null,
				entityType: "login",
				entityId: loggableEmail(email).slice(0, 80),
				details: {
					email: loggableEmail(email),
					failedCount: attempt.failedCount,
					reason: user ? "wrong_password" : "unknown_or_inactive",
					...(attempt.lockedNow ? { locked: true } : {})
				}
			});
			if (attempt.lockedNow) return sendLocked(response, request, await lockSeconds(attempt.keys));
			throw invalidCredentials();
		}
		if (user.mfa_enabled_at) {
			// Senha certa nao conta como falha; as tentativas do codigo contam nas mesmas chaves.
			for (const key of attempt.keys) await throttle.release(key, key === attempt.keys[0] ? throttle.PAIR_FREE_ATTEMPTS : throttle.EMAIL_FREE_ATTEMPTS);
			const challenge = accounts.randomToken();
			await database.query("DELETE FROM mfa_challenges WHERE user_id = $1 OR expires_at <= NOW()", [user.id]);
			await database.query("INSERT INTO mfa_challenges (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + make_interval(mins => $3))", [
				user.id,
				hashToken(challenge),
				MFA_CHALLENGE_MINUTES
			]);
			await audit("LOGIN_MFA_PENDING", { actorId: user.id, entityType: "user", entityId: user.id });
			return response.json({ mfaRequired: true, challenge, expiresInSeconds: MFA_CHALLENGE_MINUTES * 60 });
		}
		return completeLogin(request, response, user, { method: "password", throttleKeys: attempt.keys });
	})
);

// Segundo passo do login com MFA: codigo do aplicativo autenticador ou codigo de recuperacao.
router.post(
	"/mfa/verify",
	loginLimit,
	wrap(async (request, response) => {
		const { challenge, code, recoveryCode } = z
			.object({ challenge: z.string().min(10).max(200), code: z.string().max(12).optional(), recoveryCode: z.string().max(40).optional() })
			.parse(request.body);
		// Conta a tentativa no desafio ANTES de conferir o codigo (atomico: no maximo 5 por desafio, mesmo em paralelo).
		const { rows: consumed } = await database.query(
			"UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = $1 AND expires_at > NOW() AND attempts < $2 RETURNING id, user_id",
			[hashToken(challenge), MFA_CHALLENGE_ATTEMPTS]
		);
		const expired = () => new AppError(401, "A verificacao expirou. Entre novamente com e-mail e senha.", "MFA_CHALLENGE_EXPIRED");
		if (!consumed[0]) throw expired();
		const { rows } = await database.query(
			"SELECT id, name, email, role, must_change_password, mfa_enabled_at, mfa_secret, mfa_last_step FROM users WHERE id = $1 AND active = TRUE",
			[consumed[0].user_id]
		);
		const user = rows[0];
		if (!user) throw expired();
		const attempt = await reserveAttempt(user.email, { trusted: await isTrustedDevice(request, user.id) });
		if (!attempt.allowed) return sendLocked(response, request, attempt.retryAfter);
		const factor = await accounts.verifySecondFactor(user, { code, recoveryCode });
		if (!factor) {
			await audit("MFA_FAILED", { actorId: user.id, entityType: "user", entityId: user.id, details: { failedCount: attempt.failedCount } });
			if (attempt.lockedNow) return sendLocked(response, request, await lockSeconds(attempt.keys));
			throw new AppError(401, "Codigo de verificacao invalido.", "MFA_INVALID_CODE");
		}
		await database.query("DELETE FROM mfa_challenges WHERE id = $1", [consumed[0].id]);
		return completeLogin(request, response, user, { method: factor === "recovery" ? "mfa_recovery" : "mfa", throttleKeys: attempt.keys });
	})
);

// Recuperacao de senha: o administrador define uma senha provisoria (POST /api/users/:id/reset-password)
// e o usuario e obrigado a troca-la no proximo acesso. Nao ha envio de e-mail.

// Sair: sempre limpa os cookies, mesmo com sessao ja expirada.
router.post(
	"/logout",
	wrap(async (request, response) => {
		const result = await getSessionUser(request).catch(() => null);
		if (result) {
			await database.query("DELETE FROM sessions WHERE id = $1", [result.session.id]);
			await audit("LOGOUT", { actorId: result.user.id, entityType: "user", entityId: result.user.id });
		}
		clearSessionCookies(response);
		return response.status(204).send();
	})
);

router.post(
	"/logout-all",
	requireAuth.allowPending,
	wrap(async (request, response) => {
		const { rowCount } = await database.query("DELETE FROM sessions WHERE user_id = $1", [request.user.id]);
		await database.query("DELETE FROM trusted_devices WHERE user_id = $1", [request.user.id]);
		await audit("LOGOUT_ALL", { actorId: request.user.id, entityType: "user", entityId: request.user.id, details: { sessionsEnded: rowCount } });
		clearSessionCookies(response);
		return response.status(204).send();
	})
);

router.get("/me", requireAuth.allowPending, (request, response) => {
	const { id, name, email, role, mustChangePassword, mfaEnabled, mfaEnrollmentRequired } = request.user;
	return response.json({ user: publicUser({ id, name, email, role }, { mustChangePassword, mfaEnabled, mfaEnrollmentRequired }) });
});

// ------------------------------------------------------------------ Link por e-mail (senha e convite)
// Token de uso unico: "reset" vale 30 minutos; "invite" (primeiro acesso) vale 72 horas. So o hash fica no banco.
async function issueToken(userId, purpose, executor = database) {
	const token = require("node:crypto").randomBytes(32).toString("hex");
	await executor.query("DELETE FROM password_reset_tokens WHERE user_id = $1 OR expires_at <= NOW()", [userId]);
	await executor.query(
		`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, purpose) VALUES ($1, $2, NOW() + INTERVAL '${purpose === "invite" ? "72 hours" : "30 minutes"}', $3)`,
		[userId, hashToken(token), purpose]
	);
	return token;
}

// Resposta igual exista ou nao a conta (nao revela quem esta cadastrado). Sem SMTP, nada sai.
router.post(
	"/forgot-password",
	sensitiveLimit,
	wrap(async (request, response) => {
		const email = String(request.body.email || "")
			.trim()
			.toLowerCase()
			.slice(0, 254);
		if (email && mailer.isConfigured()) {
			const { rows } = await database.query("SELECT id, name, email FROM users WHERE email = $1 AND active = TRUE", [email]);
			if (rows[0]) {
				const token = await issueToken(rows[0].id, "reset");
				await audit("PASSWORD_RESET_REQUESTED", { actorId: rows[0].id, entityType: "user", entityId: rows[0].id });
				await mailer
					.send({
						to: rows[0].email,
						subject: "PlanoPneumatic: redefinição de senha",
						title: "Redefina sua senha",
						lines: [
							`Olá, ${rows[0].name.split(" ")[0]}.`,
							"Recebemos um pedido para redefinir a sua senha. O link vale por 30 minutos e só pode ser usado uma vez.",
							"Se não foi você, ignore este e-mail: sua senha continua a mesma."
						],
						action: { label: "Definir nova senha", url: mailer.appUrl(`/?reset=${token}`) }
					})
					.catch(() => {});
			}
		}
		return response.json({ message: "Se o e-mail estiver cadastrado, enviaremos instrucoes para redefinir a senha.", mailConfigured: mailer.isConfigured() });
	})
);

// Informa se o link ainda vale (a tela mostra o formulario certo ou avisa que expirou).
router.get(
	"/token/:token",
	sensitiveLimit,
	wrap(async (request, response) => {
		const { rows } = await database.query(
			"SELECT t.purpose, u.name, u.email FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW() AND u.active = TRUE",
			[hashToken(String(request.params.token))]
		);
		if (!rows[0]) return response.status(404).json({ message: "Este link expirou ou já foi usado. Peça um novo.", code: "TOKEN_INVALID" });
		return response.json({ purpose: rows[0].purpose, name: rows[0].name, email: rows[0].email });
	})
);

// Define a senha pelo link: segue a politica, encerra todas as sessoes e libera o primeiro acesso.
router.post(
	"/reset-password",
	sensitiveLimit,
	wrap(async (request, response) => {
		const token = String(request.body.token || "");
		const password = String(request.body.password || "");
		if (!token) throw badRequest("Link invalido ou expirado.", "TOKEN_INVALID");
		const result = await withTransaction(async (db) => {
			const { rows } = await db.query(
				"SELECT t.user_id, t.purpose, u.name, u.email FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW() AND u.active = TRUE FOR UPDATE OF t",
				[hashToken(token)]
			);
			if (!rows[0]) throw badRequest("Link invalido ou expirado.", "TOKEN_INVALID");
			accounts.assertPasswordPolicy(password, rows[0]);
			await db.query("UPDATE users SET password_hash = $1, must_change_password = FALSE, password_changed_at = NOW() WHERE id = $2", [
				await accounts.hashPassword(password),
				rows[0].user_id
			]);
			await db.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE token_hash = $1", [hashToken(token)]);
			await db.query("DELETE FROM sessions WHERE user_id = $1", [rows[0].user_id]);
			await audit(rows[0].purpose === "invite" ? "INVITE_ACCEPTED" : "PASSWORD_RESET_BY_LINK", {
				actorId: rows[0].user_id,
				entityType: "user",
				entityId: rows[0].user_id,
				executor: db
			});
			return rows[0];
		});
		// Quem provou ter acesso ao e-mail sai do bloqueio por tentativas.
		await throttle.unlockEmail(result.email);
		return response.json({ message: "Senha definida com sucesso." });
	})
);

const changePasswordSchema = z.object({
	currentPassword: z.string().min(1, "Informe a senha atual.").max(200),
	newPassword: z.string().min(1, "Informe a nova senha.").max(200)
});
router.post(
	"/change-password",
	requireAuth.allowPending,
	sensitiveLimit,
	wrap(async (request, response) => {
		const data = changePasswordSchema.parse(request.body);
		const result = await accounts.changePassword(request.user, request.session.id, data);
		return response.json({ message: "Senha alterada.", ...result });
	})
);

// ------------------------------------------------------------------ Sessoes ativas
router.get(
	"/sessions",
	requireAuth,
	wrap(async (request, response) =>
		response.json({ sessions: await accounts.listSessions(request.user.id, request.session.id), idleMinutes: config.sessionIdleMinutes })
	)
);

router.delete(
	"/sessions/:id",
	requireAuth,
	wrap(async (request, response) => {
		const sessionId = Number(request.params.id);
		if (!Number.isInteger(sessionId)) throw badRequest("Sessao invalida.");
		const { rowCount } = await database.query("DELETE FROM sessions WHERE id = $1 AND user_id = $2", [sessionId, request.user.id]);
		if (!rowCount) throw notFound("Sessao nao encontrada.");
		await audit("SESSION_REVOKED", {
			actorId: request.user.id,
			entityType: "user",
			entityId: request.user.id,
			details: { sessionId, current: sessionId === request.session.id }
		});
		if (sessionId === request.session.id) clearSessionCookies(response);
		return response.status(204).send();
	})
);

router.post(
	"/sessions/revoke-others",
	requireAuth,
	wrap(async (request, response) => {
		const { rowCount } = await database.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [request.user.id, request.session.id]);
		await audit("SESSION_REVOKED", {
			actorId: request.user.id,
			entityType: "user",
			entityId: request.user.id,
			details: { others: true, sessionsEnded: rowCount }
		});
		return response.json({ sessionsEnded: rowCount });
	})
);

// ------------------------------------------------------------------ MFA (TOTP)
router.get(
	"/mfa",
	requireAuth.allowPending,
	wrap(async (request, response) => {
		const allSettings = await settings.getAll();
		return response.json({
			enabled: request.user.mfaEnabled,
			required: Boolean(allSettings.mfa_required) && MFA_ROLES.includes(request.user.role),
			recoveryCodesRemaining: request.user.mfaEnabled ? await accounts.remainingRecoveryCodes(request.user.id) : 0
		});
	})
);

router.post(
	"/mfa/setup",
	requireAuth.allowPending,
	sensitiveLimit,
	wrap(async (request, response) => {
		const { password } = z.object({ password: z.string().min(1, "Confirme sua senha.").max(200) }).parse(request.body);
		const user = await accounts.loadUser(request.user.id);
		await accounts.verifyCurrentPassword(user, password);
		return response.json(await accounts.startMfaSetup(user));
	})
);

router.post(
	"/mfa/enable",
	requireAuth.allowPending,
	sensitiveLimit,
	wrap(async (request, response) => {
		const { code } = z.object({ code: z.string().min(6).max(12) }).parse(request.body);
		const user = await accounts.loadUser(request.user.id);
		return response.json(await accounts.enableMfa(user, code, request.session.id));
	})
);

router.post(
	"/mfa/disable",
	requireAuth,
	sensitiveLimit,
	wrap(async (request, response) => {
		const data = z
			.object({ password: z.string().min(1).max(200), code: z.string().max(12).optional(), recoveryCode: z.string().max(40).optional() })
			.parse(request.body);
		const allSettings = await settings.getAll();
		if (allSettings.mfa_required && MFA_ROLES.includes(request.user.role))
			throw new AppError(403, "A verificacao em duas etapas e obrigatoria para o seu perfil.", "MFA_REQUIRED");
		const user = await accounts.loadUser(request.user.id);
		if (!user.mfa_enabled_at) throw badRequest("A verificacao em duas etapas nao esta ativa.");
		await accounts.verifyCurrentPassword(user, data.password);
		if (!(await accounts.verifySecondFactor(user, data))) throw new AppError(400, "Codigo de verificacao invalido.", "MFA_INVALID_CODE", { field: "code" });
		await accounts.disableMfa(user, user.id);
		return response.status(204).send();
	})
);

router.post(
	"/mfa/recovery-codes",
	requireAuth,
	sensitiveLimit,
	wrap(async (request, response) => {
		const { code } = z.object({ code: z.string().min(6).max(12) }).parse(request.body);
		const user = await accounts.loadUser(request.user.id);
		if (!user.mfa_enabled_at) throw badRequest("A verificacao em duas etapas nao esta ativa.");
		if ((await accounts.verifySecondFactor(user, { code })) !== "totp")
			throw new AppError(400, "Codigo de verificacao invalido.", "MFA_INVALID_CODE", { field: "code" });
		return response.json({ recoveryCodes: await accounts.regenerateRecoveryCodes(user) });
	})
);

module.exports = { router, issueToken };
