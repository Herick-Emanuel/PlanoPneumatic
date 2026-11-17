// Limpeza agendada (P2): sessoes vencidas ou ociosas, tokens de redefinicao, contadores de
// login antigos e o registro de navegacao alem do prazo de retencao (LGPD).
const { database } = require("../db");
const { config } = require("../config");
const { logEvent } = require("../middleware/errors");

async function runHousekeeping() {
	const result = {};
	const run = async (name, sql, values = []) => {
		result[name] = (await database.query(sql, values)).rowCount;
	};
	await run("sessions", "DELETE FROM sessions WHERE expires_at <= NOW() OR last_seen_at < NOW() - make_interval(mins => $1)", [config.sessionIdleMinutes]);
	await run(
		"passwordResetTokens",
		"DELETE FROM password_reset_tokens WHERE expires_at <= NOW() - INTERVAL '1 day' OR (used_at IS NOT NULL AND used_at <= NOW() - INTERVAL '1 day')"
	);
	await run("mfaChallenges", "DELETE FROM mfa_challenges WHERE expires_at <= NOW()");
	await run(
		"loginThrottle",
		"DELETE FROM login_throttle WHERE last_failed_at < NOW() - INTERVAL '24 hours' AND (locked_until IS NULL OR locked_until < NOW())"
	);
	await run("trustedDevices", "DELETE FROM trusted_devices WHERE expires_at <= NOW()");
	if (config.activityRetentionDays > 0)
		await run("activity", "DELETE FROM user_activity_log WHERE created_at < NOW() - make_interval(days => $1)", [config.activityRetentionDays]);
	return result;
}

function startHousekeeping(intervalMs = config.housekeepingIntervalMs) {
	const tick = () =>
		runHousekeeping()
			.then((removed) => logEvent("housekeeping", removed))
			.catch((error) => logEvent("housekeeping_error", { error: error.message }));
	const first = setTimeout(tick, 30000);
	const timer = setInterval(tick, intervalMs);
	for (const handle of [first, timer]) if (typeof handle.unref === "function") handle.unref();
	return timer;
}

module.exports = { runHousekeeping, startHousekeeping };
