const path = require("node:path");

const isProduction = process.env.NODE_ENV === "production";
// Sem enderecos de producao embutidos: em producao FRONTEND_ORIGIN e API_PUBLIC_URL sao obrigatorias.
const DEV_ORIGIN = "http://localhost:3000";

const config = {
	isProduction,
	port: Number(process.env.PORT || 3000),
	host: process.env.HOST || "0.0.0.0",
	frontendDirectory: path.join(__dirname, "..", "frontend"),
	frontendOrigin: process.env.FRONTEND_ORIGIN || (isProduction ? "" : DEV_ORIGIN),
	apiOrigin: process.env.API_PUBLIC_URL || "",
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
		const missing = ["FRONTEND_ORIGIN", "API_PUBLIC_URL"].filter((name) => !process.env[name]);
		if (missing.length)
			throw new Error(
				`${missing.join(" e ")} ${missing.length > 1 ? "sao obrigatorias" : "e obrigatoria"} em producao (endereco publico do frontend e da API).`
			);
		for (const name of ["FRONTEND_ORIGIN", "API_PUBLIC_URL"])
			if (!/^https:\/\/[^/]+$/.test(process.env[name]))
				throw new Error(`${name} deve ser uma URL https sem barra no final, por exemplo https://app.empresa.com.br.`);
	}
	if (process.env.SMTP_HOST && !process.env.MAIL_FROM) warnings.push("SMTP_HOST definido sem MAIL_FROM; usando o remetente padrao.");
	if (Boolean(process.env.WHATSAPP_TOKEN) !== Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID))
		warnings.push("WhatsApp precisa de WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID juntos; canal desligado.");
	if (isProduction && !process.env.SMTP_HOST) warnings.push("SMTP_HOST nao definido: recuperacao de senha, convites e avisos por e-mail ficam desligados.");
	if (!Number.isFinite(config.sessionDurationInDays) || config.sessionDurationInDays <= 0) throw new Error("SESSION_DURATION_DAYS invalido.");
	return warnings;
}

module.exports = { config, validateConfig };
