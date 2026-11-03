const crypto = require("node:crypto");
const { database } = require("../db");
const { config } = require("../config");
const { can } = require("../domain/permissions");
const { forbidden, AppError } = require("./errors");

function hashToken(token) {
	return crypto.createHash("sha256").update(token).digest("hex");
}

async function createSession(userId) {
	const token = crypto.randomBytes(32).toString("hex");
	const expiresAt = new Date(Date.now() + config.sessionDurationInDays * 86400000);
	await database.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [userId, hashToken(token), expiresAt]);
	return { token, expiresAt: expiresAt.toISOString() };
}

function bearerToken(request) {
	const authorization = request.get("authorization") || "";
	return authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
}

async function getSessionUser(request) {
	const token = bearerToken(request);
	if (!token) return null;
	const { rows } = await database.query(
		"SELECT users.id, users.name, users.email, users.role, sessions.token_hash, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = $1 AND users.active = TRUE",
		[hashToken(token)]
	);
	const session = rows[0];
	if (!session || new Date(session.expires_at) <= new Date()) {
		if (session) await database.query("DELETE FROM sessions WHERE token_hash = $1", [session.token_hash]);
		return null;
	}
	return { id: session.id, name: session.name, email: session.email, role: session.role };
}

async function requireAuth(request, response, next) {
	try {
		const user = await getSessionUser(request);
		if (!user) return next(new AppError(401, "Sessao invalida ou expirada.", "UNAUTHENTICATED"));
		request.user = user;
		return next();
	} catch (error) {
		return next(error);
	}
}

function requireCapability(capability) {
	return (request, response, next) => (can(request.user, capability) ? next() : next(forbidden()));
}

module.exports = { hashToken, createSession, bearerToken, requireAuth, requireCapability };
