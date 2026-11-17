// Limite de login (P0), guardado no banco para valer entre reinicios e entre instancias.
//
// Duas chaves por tentativa:
// - e-mail + IP: 4 tentativas livres; a 5a sem acerto bloqueia aquele e-mail naquele IP por 1 min, depois
//   2, 4, 8, 16, 32 e no maximo 60 min a cada nova falha;
// - so o e-mail (ataque distribuido, de muitos IPs): mesma progressao a partir de 20 falhas. Aparelhos onde a
//   pessoa ja entrou com sucesso (cookie de aparelho conhecido) nao passam por esta chave, entao um atacante
//   nao consegue deixar o dono da conta trancado do lado de fora.
// Vale para qualquer e-mail digitado, exista ou nao a conta. A tabela guarda so hashes.
//
// Cada tentativa e RESERVADA de forma atomica antes de conferir a senha/codigo (INSERT ... ON CONFLICT com
// row lock): requisicoes em paralelo nao conseguem passar do limite. Acerto apaga o contador.
const { database } = require("../db");
const { sha256 } = require("../security/crypto");

const PAIR_FREE_ATTEMPTS = 5;
const EMAIL_FREE_ATTEMPTS = 20;
const MAX_LOCK_MINUTES = 60;

const normalizeEmail = (email) =>
	String(email || "")
		.trim()
		.toLowerCase()
		.slice(0, 180);
const emailHash = (email) => sha256(normalizeEmail(email));
const pairKey = (email, ip) => sha256(`pair:${normalizeEmail(email)}|${String(ip || "")}`);
const emailKey = (email) => sha256(`email:${normalizeEmail(email)}`);

const NEW_COUNT = "(CASE WHEN login_throttle.last_failed_at < NOW() - INTERVAL '24 hours' THEN 1 ELSE login_throttle.failed_count + 1 END)";

async function secondsLocked(key, executor = database) {
	const { rows } = await executor.query(
		"SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW()))))::int AS seconds FROM login_throttle WHERE throttle_key = $1 AND locked_until > NOW()",
		[key]
	);
	return rows[0]?.seconds || 0;
}

/**
 * Reserva uma tentativa. Devolve { allowed: false, retryAfter } se a chave ja esta bloqueada; senao
 * { allowed: true, lockedNow } — lockedNow indica que esta tentativa atingiu o limite (se ela falhar, o
 * bloqueio ja esta valendo; se acertar, `clear` desfaz).
 */
async function reserve(key, email, freeAttempts) {
	const { rows } = await database.query(
		`INSERT INTO login_throttle (throttle_key, email_hash, failed_count, last_failed_at, locked_until)
		 VALUES ($1, $2, 1, NOW(), CASE WHEN 1 >= $3::int THEN NOW() + INTERVAL '1 minute' END)
		 ON CONFLICT (throttle_key) DO UPDATE SET
		   failed_count = ${NEW_COUNT},
		   last_failed_at = NOW(),
		   locked_until = CASE WHEN ${NEW_COUNT} >= $3::int THEN NOW() + make_interval(mins => LEAST($4::int, power(2, ${NEW_COUNT} - $3::int))::int) ELSE NULL END
		 WHERE login_throttle.locked_until IS NULL OR login_throttle.locked_until <= NOW()
		 RETURNING failed_count, locked_until`,
		[key, emailHash(email), freeAttempts, MAX_LOCK_MINUTES]
	);
	if (!rows[0]) return { allowed: false, retryAfter: Math.max(1, await secondsLocked(key)) };
	return { allowed: true, failedCount: rows[0].failed_count, lockedNow: Boolean(rows[0].locked_until) };
}

// Devolve a tentativa reservada (senha certa aguardando o MFA nao conta como falha).
async function release(key, freeAttempts) {
	await database.query(
		"UPDATE login_throttle SET failed_count = GREATEST(failed_count - 1, 0), locked_until = CASE WHEN failed_count - 1 < $2::int THEN NULL ELSE locked_until END WHERE throttle_key = $1",
		[key, freeAttempts]
	);
}

const clear = (keys, executor = database) => executor.query("DELETE FROM login_throttle WHERE throttle_key = ANY($1::text[])", [keys]);

// Desbloqueio manual (administrador ou `npm run unlock-login`): remove os contadores do e-mail em todos os IPs.
async function unlockEmail(email, executor = database) {
	const { rowCount } = await executor.query("DELETE FROM login_throttle WHERE email_hash = $1", [emailHash(email)]);
	return rowCount;
}

module.exports = {
	PAIR_FREE_ATTEMPTS,
	EMAIL_FREE_ATTEMPTS,
	MAX_LOCK_MINUTES,
	normalizeEmail,
	emailHash,
	pairKey,
	emailKey,
	reserve,
	release,
	clear,
	unlockEmail,
	secondsLocked
};
