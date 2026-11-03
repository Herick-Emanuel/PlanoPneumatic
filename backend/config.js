const path = require("node:path");

const isProduction = process.env.NODE_ENV === "production";
const DEFAULT_FRONTEND_ORIGIN = "https://planopneumatic-production.up.railway.app";
const DEFAULT_API_ORIGIN = "https://planopneumaticapi-production.up.railway.app";

const config = {
	isProduction,
	port: Number(process.env.PORT || 3000),
	host: process.env.HOST || "0.0.0.0",
	frontendDirectory: path.join(__dirname, "..", "frontend"),
	frontendOrigin: process.env.FRONTEND_ORIGIN || DEFAULT_FRONTEND_ORIGIN,
	apiOrigin: process.env.API_PUBLIC_URL || DEFAULT_API_ORIGIN,
	sessionDurationInDays: Number(process.env.SESSION_DURATION_DAYS || 1),
	maxAttachmentBytes: Number(process.env.MAX_ATTACHMENT_BYTES || 10 * 1024 * 1024),
	buildId: process.env.BUILD_ID || process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || "dev",
	slaCheckIntervalMs: Number(process.env.SLA_CHECK_INTERVAL_MS || 15 * 60 * 1000)
};

// Valida as variaveis na subida. Retorna a lista de avisos para o log.
function validateConfig() {
	const warnings = [];
	if (isProduction) {
		if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL e obrigatoria em producao.");
		if (!process.env.FRONTEND_ORIGIN) warnings.push("FRONTEND_ORIGIN nao definida; usando o valor padrao embutido.");
		if (!process.env.API_PUBLIC_URL) warnings.push("API_PUBLIC_URL nao definida; usando o valor padrao embutido.");
	}
	if (!Number.isFinite(config.sessionDurationInDays) || config.sessionDurationInDays <= 0) throw new Error("SESSION_DURATION_DAYS invalido.");
	return warnings;
}

module.exports = { config, validateConfig };
