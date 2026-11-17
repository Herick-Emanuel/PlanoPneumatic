// Regras de conta compartilhadas pelas rotas de autenticacao, conta e usuarios: politica de senha,
// troca de senha, sessoes e MFA.
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const { database, withTransaction } = require("../db");
const { passwordProblem } = require("../security/passwords");
const { encrypt, decrypt, sha256 } = require("../security/crypto");
const totp = require("../security/totp");
const { AppError, badRequest } = require("../middleware/errors");
const { audit } = require("./audit");

const BCRYPT_ROUNDS = 12;
const MAX_SESSIONS_PER_USER = 10;

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

function assertPasswordPolicy(password, context) {
	const problem = passwordProblem(password, context);
	if (problem) throw new AppError(400, problem, "WEAK_PASSWORD", { field: "password" });
}

async function loadUser(userId, executor = database) {
	const { rows } = await executor.query("SELECT id, name, email, role, password_hash, mfa_secret, mfa_pending_secret, mfa_enabled_at, mfa_last_step FROM users WHERE id = $1 AND active = TRUE", [userId]);
	return rows[0] || null;
}

async function verifyCurrentPassword(user, password) {
	if (!password || !(await bcrypt.compare(String(password), user.password_hash))) throw new AppError(400, "Senha atual incorreta.", "INVALID_CURRENT_PASSWORD", { field: "currentPassword" });
}

// P1: troca de senha exige a senha atual, segue a politica e encerra as outras sessoes.
async function changePassword(actor, currentSessionId, { currentPassword, newPassword }) {
	const user = await loadUser(actor.id);
	if (!user) throw new AppError(401, "Sessao invalida ou expirada.", "UNAUTHENTICATED");
	await verifyCurrentPassword(user, currentPassword);
	assertPasswordPolicy(newPassword, user);
	if (await bcrypt.compare(String(newPassword), user.password_hash)) throw badRequest("A nova senha deve ser diferente da atual.", "SAME_PASSWORD");
	const passwordHash = await hashPassword(newPassword);
	return withTransaction(async (db) => {
		await db.query("UPDATE users SET password_hash = $1, must_change_password = FALSE, password_changed_at = NOW() WHERE id = $2", [passwordHash, user.id]);
		const { rowCount } = await db.query("DELETE FROM sessions WHERE user_id = $1 AND id IS DISTINCT FROM $2", [user.id, currentSessionId || null]);
		await db.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [user.id]);
		await audit("PASSWORD_CHANGED", { actorId: user.id, entityType: "user", entityId: user.id, details: { otherSessionsEnded: rowCount }, executor: db });
		return { otherSessionsEnded: rowCount };
	});
}

// Mantem no maximo MAX_SESSIONS_PER_USER sessoes por usuario (as mais antigas saem).
async function pruneSessions(userId, executor = database) {
	await executor.query(
		"DELETE FROM sessions WHERE user_id = $1 AND id NOT IN (SELECT id FROM sessions WHERE user_id = $1 ORDER BY last_seen_at DESC, id DESC LIMIT $2)",
		[userId, MAX_SESSIONS_PER_USER]
	);
}

async function listSessions(userId, currentSessionId) {
	const { rows } = await database.query(
		"SELECT id, created_at AS \"createdAt\", last_seen_at AS \"lastSeenAt\", expires_at AS \"expiresAt\", ip, user_agent AS \"userAgent\" FROM sessions WHERE user_id = $1 AND expires_at > NOW() ORDER BY last_seen_at DESC, id DESC",
		[userId]
	);
	return rows.map((row) => ({ ...row, current: row.id === currentSessionId }));
}

// ----------------------------------------------------------------- MFA (TOTP)
async function startMfaSetup(user) {
	if (user.mfa_enabled_at) throw new AppError(409, "A verificacao em duas etapas ja esta ativa.", "MFA_ALREADY_ENABLED");
	const secret = totp.generateSecret();
	await database.query("UPDATE users SET mfa_pending_secret = $1 WHERE id = $2", [encrypt(secret), user.id]);
	const otpauthUri = totp.otpauthUri(secret, user.email);
	const QRCode = require("qrcode");
	const qrSvg = await QRCode.toString(otpauthUri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
	return { secret, otpauthUri, qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString("base64")}` };
}

async function replaceRecoveryCodes(userId, executor) {
	const codes = totp.recoveryCodes();
	await executor.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [userId]);
	for (const code of codes) await executor.query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [userId, sha256(totp.normalizeRecoveryCode(code))]);
	return codes;
}

// Confirma o primeiro codigo do aplicativo, ativa o MFA, gera os codigos de recuperacao e encerra as outras sessoes.
async function enableMfa(user, code, currentSessionId) {
	if (user.mfa_enabled_at) throw new AppError(409, "A verificacao em duas etapas ja esta ativa.", "MFA_ALREADY_ENABLED");
	if (!user.mfa_pending_secret) throw badRequest("Inicie a configuracao do MFA antes de confirmar o codigo.", "MFA_SETUP_MISSING");
	const secret = decrypt(user.mfa_pending_secret);
	const step = totp.verify(secret, code);
	if (step === null) throw new AppError(400, "Codigo invalido. Confira o horario do celular e use o codigo atual.", "MFA_INVALID_CODE", { field: "code" });
	return withTransaction(async (db) => {
		await db.query("UPDATE users SET mfa_secret = $1, mfa_pending_secret = NULL, mfa_enabled_at = NOW(), mfa_last_step = $2 WHERE id = $3", [encrypt(secret), step, user.id]);
		const { rowCount } = await db.query("DELETE FROM sessions WHERE user_id = $1 AND id IS DISTINCT FROM $2", [user.id, currentSessionId || null]);
		const recoveryCodes = await replaceRecoveryCodes(user.id, db);
		await audit("MFA_ENABLED", { actorId: user.id, entityType: "user", entityId: user.id, details: { otherSessionsEnded: rowCount }, executor: db });
		return { recoveryCodes };
	});
}

/**
 * Confere um codigo TOTP (o mesmo codigo nao vale duas vezes) ou um codigo de recuperacao (uso unico).
 * Devolve "totp", "recovery" ou null.
 */
async function verifySecondFactor(user, { code, recoveryCode }) {
	if (!user.mfa_secret) return null;
	if (code) {
		const step = totp.verify(decrypt(user.mfa_secret), code, { lastUsedStep: user.mfa_last_step });
		if (step === null) return null;
		const { rowCount } = await database.query("UPDATE users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)", [user.id, step]);
		return rowCount ? "totp" : null;
	}
	if (recoveryCode) {
		const normalized = totp.normalizeRecoveryCode(recoveryCode);
		if (normalized.length !== 10) return null;
		const { rows } = await database.query("UPDATE mfa_recovery_codes SET used_at = NOW() WHERE id = (SELECT id FROM mfa_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL LIMIT 1) RETURNING id", [user.id, sha256(normalized)]);
		if (!rows[0]) return null;
		await audit("MFA_RECOVERY_USED", { actorId: user.id, entityType: "user", entityId: user.id });
		return "recovery";
	}
	return null;
}

async function disableMfa(user, actorId, action = "MFA_DISABLED", executor = null) {
	const run = async (db) => {
		await db.query("UPDATE users SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL WHERE id = $1", [user.id]);
		await db.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [user.id]);
		await audit(action, { actorId, entityType: "user", entityId: user.id, executor: db });
	};
	return executor ? run(executor) : withTransaction(run);
}

async function regenerateRecoveryCodes(user) {
	return withTransaction(async (db) => {
		const codes = await replaceRecoveryCodes(user.id, db);
		await audit("MFA_RECOVERY_REGENERATED", { actorId: user.id, entityType: "user", entityId: user.id, executor: db });
		return codes;
	});
}

async function remainingRecoveryCodes(userId) {
	const { rows } = await database.query("SELECT COUNT(*)::int AS count FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL", [userId]);
	return rows[0].count;
}

const randomToken = () => crypto.randomBytes(32).toString("hex");

module.exports = {
	BCRYPT_ROUNDS, hashPassword, assertPasswordPolicy, loadUser, verifyCurrentPassword, changePassword, pruneSessions, listSessions,
	startMfaSetup, enableMfa, verifySecondFactor, disableMfa, regenerateRecoveryCodes, remainingRecoveryCodes, randomToken
};
