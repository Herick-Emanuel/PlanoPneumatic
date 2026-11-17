// Sessao (P0): o token fica em cookie HttpOnly + Secure + SameSite=Strict, invisivel para o JavaScript da
// pagina. Requisicoes que alteram dados exigem o cabecalho X-CSRF-Token, derivado do token da sessao e
// entregue num segundo cookie legivel (double submit). Clientes de API podem continuar usando
// "Authorization: Bearer"; nesse caso o CSRF nao se aplica (o navegador nunca envia esse cabecalho sozinho).
const crypto = require("node:crypto");
const { database } = require("../db");
const { config } = require("../config");
const { can } = require("../domain/permissions");
const { roles } = require("../domain/constants");
const settings = require("../services/settings");
const { forbidden, AppError } = require("./errors");
const { safeEqual } = require("../security/crypto");

const SESSION_COOKIE = config.cookieSecure ? "__Host-pp_session" : "pp_session";
const CSRF_COOKIE = config.cookieSecure ? "__Host-pp_csrf" : "pp_csrf";
// "Aparelho conhecido": marca o navegador onde a pessoa ja entrou, para o limite de login por e-mail.
const DEVICE_COOKIE = config.cookieSecure ? "__Host-pp_device" : "pp_device";
const DEVICE_DAYS = 180;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Perfis para os quais o administrador pode tornar o MFA obrigatorio (configuracao mfa_required).
const MFA_ROLES = Object.freeze([roles.ADMIN, roles.MANAGER]);
const TOUCH_INTERVAL_MS = 60000;

function hashToken(token) {
	return crypto.createHash("sha256").update(String(token)).digest("hex");
}

const csrfTokenFor = (sessionToken) => crypto.createHmac("sha256", String(sessionToken)).update("pp-csrf-v1").digest("base64url");

function parseCookies(request) {
	const header = request.headers.cookie || "";
	const cookies = {};
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		const name = part.slice(0, index).trim();
		if (!name || name in cookies) continue;
		try { cookies[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* cookie malformado */ }
	}
	return cookies;
}

function serializeCookie(name, value, { maxAgeSeconds, httpOnly }) {
	const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Strict"];
	if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
	if (maxAgeSeconds === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
	if (httpOnly) parts.push("HttpOnly");
	if (config.cookieSecure) parts.push("Secure");
	return parts.join("; ");
}

function setSessionCookies(response, session) {
	const maxAgeSeconds = (new Date(session.expiresAt).getTime() - Date.now()) / 1000;
	response.append("Set-Cookie", serializeCookie(SESSION_COOKIE, session.token, { maxAgeSeconds, httpOnly: true }));
	response.append("Set-Cookie", serializeCookie(CSRF_COOKIE, session.csrfToken, { maxAgeSeconds, httpOnly: false }));
}

function clearSessionCookies(response) {
	response.append("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { maxAgeSeconds: 0, httpOnly: true }));
	response.append("Set-Cookie", serializeCookie(CSRF_COOKIE, "", { maxAgeSeconds: 0, httpOnly: false }));
}

async function isTrustedDevice(request, userId) {
	const token = parseCookies(request)[DEVICE_COOKIE];
	if (!token || token.length > 200 || !userId) return false;
	const { rows } = await database.query("UPDATE trusted_devices SET last_used_at = NOW() WHERE user_id = $1 AND token_hash = $2 AND expires_at > NOW() RETURNING id", [userId, hashToken(token)]);
	return Boolean(rows[0]);
}

// Depois de um login completo: renova o cookie do aparelho (ou cria um novo).
async function rememberDevice(request, response, userId, executor = database) {
	const current = parseCookies(request)[DEVICE_COOKIE];
	if (current && current.length <= 200) {
		const { rowCount } = await executor.query("UPDATE trusted_devices SET last_used_at = NOW(), expires_at = NOW() + make_interval(days => $3) WHERE user_id = $1 AND token_hash = $2", [userId, hashToken(current), DEVICE_DAYS]);
		if (rowCount) return;
	}
	const token = crypto.randomBytes(32).toString("hex");
	await executor.query("INSERT INTO trusted_devices (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + make_interval(days => $3))", [userId, hashToken(token), DEVICE_DAYS]);
	// Mantem no maximo 20 aparelhos por usuario.
	await executor.query("DELETE FROM trusted_devices WHERE user_id = $1 AND id NOT IN (SELECT id FROM trusted_devices WHERE user_id = $1 ORDER BY last_used_at DESC LIMIT 20)", [userId]);
	response.append("Set-Cookie", serializeCookie(DEVICE_COOKIE, token, { maxAgeSeconds: DEVICE_DAYS * 86400, httpOnly: true }));
}

async function createSession(userId, { ip = null, userAgent = null, executor = database } = {}) {
	const token = crypto.randomBytes(32).toString("hex");
	const expiresAt = new Date(Date.now() + config.sessionDurationInDays * 86400000);
	const { rows } = await executor.query(
		"INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5) RETURNING id",
		[userId, hashToken(token), expiresAt, ip, userAgent ? String(userAgent).slice(0, 300) : null]
	);
	return { id: rows[0].id, token, csrfToken: csrfTokenFor(token), expiresAt: expiresAt.toISOString() };
}

function bearerToken(request) {
	const authorization = request.get("authorization") || "";
	return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
}

// Token da requisicao e a forma como chegou ("bearer" ou "cookie").
function sessionToken(request) {
	const bearer = bearerToken(request);
	if (bearer) return { token: bearer, method: "bearer" };
	const cookie = parseCookies(request)[SESSION_COOKIE];
	return cookie ? { token: cookie, method: "cookie" } : { token: null, method: null };
}

async function getSessionUser(request) {
	const { token, method } = sessionToken(request);
	if (!token || token.length > 200) return null;
	const { rows } = await database.query(
		`SELECT users.id, users.name, users.email, users.role, users.manager_id, users.must_change_password, users.mfa_enabled_at,
		        sessions.id AS session_id, sessions.expires_at, sessions.last_seen_at
		   FROM sessions JOIN users ON users.id = sessions.user_id
		  WHERE sessions.token_hash = $1 AND users.active = TRUE`,
		[hashToken(token)]
	);
	const session = rows[0];
	if (!session) return null;
	const now = Date.now();
	const idleLimit = config.sessionIdleMinutes * 60000;
	if (new Date(session.expires_at).getTime() <= now || now - new Date(session.last_seen_at).getTime() > idleLimit) {
		await database.query("DELETE FROM sessions WHERE id = $1", [session.session_id]);
		return null;
	}
	if (now - new Date(session.last_seen_at).getTime() > TOUCH_INTERVAL_MS) {
		await database.query("UPDATE sessions SET last_seen_at = NOW() WHERE id = $1", [session.session_id]);
	}
	const allSettings = await settings.getAll();
	const mfaEnrollmentRequired = Boolean(allSettings.mfa_required) && MFA_ROLES.includes(session.role) && !session.mfa_enabled_at;
	return {
		user: {
			id: session.id,
			name: session.name,
			email: session.email,
			role: session.role,
			managerId: session.manager_id,
			// Gerente com escopo de time ligado ve apenas os processos do proprio time.
			teamScoped: session.role === roles.MANAGER && Boolean(allSettings.manager_team_scope),
			mustChangePassword: session.must_change_password,
			mfaEnabled: Boolean(session.mfa_enabled_at),
			mfaEnrollmentRequired
		},
		session: { id: session.session_id, token, method }
	};
}

function checkCsrf(request, session) {
	if (session.method !== "cookie" || !UNSAFE_METHODS.has(request.method)) return true;
	const provided = request.get("x-csrf-token") || "";
	return Boolean(provided) && safeEqual(provided, csrfTokenFor(session.token));
}

/**
 * Autentica a requisicao. Por padrao bloqueia quem ainda precisa trocar a senha (inicial ou provisoria) ou
 * ativar o MFA obrigatorio; as rotas que resolvem essas pendencias usam `requireAuth.allowPending`.
 */
function authenticate({ allowPending }) {
	return async (request, response, next) => {
		try {
			const result = await getSessionUser(request);
			if (!result) return next(new AppError(401, "Sessao invalida ou expirada.", "UNAUTHENTICATED"));
			if (!checkCsrf(request, result.session)) return next(new AppError(403, "Token de seguranca (CSRF) ausente ou invalido. Recarregue a pagina.", "CSRF_INVALID"));
			request.user = result.user;
			request.session = result.session;
			if (!allowPending) {
				if (result.user.mustChangePassword) return next(new AppError(403, "Troque sua senha para continuar.", "PASSWORD_CHANGE_REQUIRED"));
				if (result.user.mfaEnrollmentRequired) return next(new AppError(403, "Ative a verificacao em duas etapas (MFA) para continuar.", "MFA_ENROLLMENT_REQUIRED"));
			}
			return next();
		} catch (error) {
			return next(error);
		}
	};
}

const requireAuth = authenticate({ allowPending: false });
requireAuth.allowPending = authenticate({ allowPending: true });

function requireCapability(capability) {
	return (request, response, next) => (can(request.user, capability) ? next() : next(forbidden()));
}

module.exports = {
	SESSION_COOKIE, CSRF_COOKIE, DEVICE_COOKIE, MFA_ROLES, hashToken, isTrustedDevice, rememberDevice, csrfTokenFor, parseCookies, createSession, setSessionCookies, clearSessionCookies,
	bearerToken, sessionToken, getSessionUser, requireAuth, requireCapability
};
