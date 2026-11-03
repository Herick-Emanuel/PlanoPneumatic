const { database } = require("../db");

const DEFAULTS = Object.freeze({ alerts_enabled: true, auto_refresh: true, require_documents: true });

async function get(key, fallback, executor = database) {
	const { rows } = await executor.query("SELECT value FROM app_settings WHERE key = $1", [key]);
	return rows[0] ? rows[0].value : fallback;
}

async function getAll() {
	const { rows } = await database.query("SELECT key, value FROM app_settings");
	const result = { ...DEFAULTS };
	for (const row of rows) result[row.key] = row.value;
	return result;
}

async function set(key, value, userId) {
	if (!(key in DEFAULTS)) return false;
	await database.query(
		"INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()",
		[key, JSON.stringify(value), userId]
	);
	return true;
}

module.exports = { get, getAll, set, DEFAULTS };
