const { database } = require("../db");

const DEFAULTS = Object.freeze({
	alerts_enabled: true,
	auto_refresh: true,
	require_documents: true,
	// Seguranca (somente administrador altera):
	// gerente ve apenas os processos do proprio time (ele e os usuarios com manager_id = ele).
	manager_team_scope: false,
	// administradores e gerentes so entram depois de ativar o MFA (TOTP).
	mfa_required: false,
	// registra as telas visitadas para os relatorios de uso (retencao em ACTIVITY_RETENTION_DAYS).
	activity_tracking: true
});
const SECURITY_SETTINGS = Object.freeze(["manager_team_scope", "mfa_required", "activity_tracking"]);

// Configuracoes lidas a cada requisicao (escopo do gerente) ficam em cache curto.
const CACHE_MS = 10000;
let cache = null;
let cachedAt = 0;

async function getAll() {
	if (cache && Date.now() - cachedAt < CACHE_MS) return { ...cache };
	const { rows } = await database.query("SELECT key, value FROM app_settings");
	const result = { ...DEFAULTS };
	for (const row of rows) result[row.key] = row.value;
	cache = result;
	cachedAt = Date.now();
	return { ...result };
}

async function get(key, fallback, executor = database) {
	if (executor === database) {
		const all = await getAll();
		return key in all ? all[key] : fallback;
	}
	const { rows } = await executor.query("SELECT value FROM app_settings WHERE key = $1", [key]);
	return rows[0] ? rows[0].value : fallback;
}

const invalidate = () => { cache = null; };

async function set(key, value, userId) {
	if (!Object.hasOwn(DEFAULTS, key)) return false;
	await database.query(
		"INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()",
		[key, JSON.stringify(value), userId]
	);
	invalidate();
	return true;
}

module.exports = { get, getAll, set, invalidate, DEFAULTS, SECURITY_SETTINGS };
