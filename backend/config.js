const path = require("node:path");

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";
// Sem enderecos de producao embutidos: em producao FRONTEND_ORIGIN e API_PUBLIC_URL sao obrigatorias.
const DEV_ORIGIN = "http://localhost:3000";

const bool = (value, fallback) => (value === undefined || value === "" ? fallback : ["1", "true", "yes", "on"].includes(String(value).toLowerCase()));
const list = (value) =>
	String(value || "")
		.split(",")
		.map((item) => item.trim().replace(/\/$/, ""))
		.filter(Boolean);

// "trust proxy" do Express: quantos saltos de proxy na frente da API sao confiaveis para ler o IP do cliente.
// Aceita numero ("1", "2"), "true"/"false" ou uma lista de IPs/CIDRs ("loopback, 10.0.0.0/8").
function parseTrustProxy(value) {
	if (value === undefined || value === "") return isProduction ? 1 : "loopback";
	if (/^\d+$/.test(value)) return Number(value);
	if (["true", "false"].includes(value)) return value === "true";
	return list(value);
}

const frontendOrigins = list(process.env.FRONTEND_ORIGIN || (isProduction ? "" : DEV_ORIGIN));

const config = {
	isProduction,
	isTest,
	port: Number(process.env.PORT || 3000),
	host: process.env.HOST || "0.0.0.0",
	frontendDirectory: path.join(__dirname, "..", "frontend"),
	frontendOrigin: frontendOrigins[0] || "",
	frontendOrigins,
	apiOrigin: (process.env.API_PUBLIC_URL || "").replace(/\/$/, ""),
	sessionDurationInDays: Number(process.env.SESSION_DURATION_DAYS || 1),
	// Sessao sem uso por este tempo expira, mesmo dentro da validade total.
	sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 120),
	// Cookie com Secure exige HTTPS. Em desenvolvimento local (http://localhost) fica desligado por padrao.
	cookieSecure: bool(process.env.COOKIE_SECURE, isProduction || process.env.NODE_ENV === "staging"),
	trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
	// Segredo compartilhado com o Nginx do frontend: so com ele a API aceita o X-Real-IP enviado pelo proxy.
	proxySharedSecret: process.env.PROXY_SHARED_SECRET || "",
	// Chave de 32 bytes (base64 ou hex) para cifrar segredos de webhook e de MFA no banco.
	encryptionKey: process.env.APP_ENCRYPTION_KEY || "",
	maxAttachmentBytes: Number(process.env.MAX_ATTACHMENT_BYTES || 10 * 1024 * 1024),
	buildId: process.env.BUILD_ID || process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || "dev",
	slaCheckIntervalMs: Number(process.env.SLA_CHECK_INTERVAL_MS || 15 * 60 * 1000),
	housekeepingIntervalMs: Number(process.env.HOUSEKEEPING_INTERVAL_MS || 60 * 60 * 1000),
	activityRetentionDays: Number(process.env.ACTIVITY_RETENTION_DAYS || 90)
};

// Valida as variaveis na subida. Retorna a lista de avisos para o log.
function validateConfig() {
	const warnings = [];
	if ((isProduction || process.env.NODE_ENV === "staging") && !config.encryptionKey) {
		throw new Error(
			"APP_ENCRYPTION_KEY e obrigatoria em producao e homologacao (gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\")."
		);
	}
	if (isProduction) {
		if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL e obrigatoria em producao.");
		const missing = ["FRONTEND_ORIGIN", "API_PUBLIC_URL"].filter((name) => !process.env[name]);
		if (missing.length)
			throw new Error(
				`${missing.join(" e ")} ${missing.length > 1 ? "sao obrigatorias" : "e obrigatoria"} em producao (endereco publico do frontend e da API).`
			);
		// FRONTEND_ORIGIN aceita varios enderecos separados por virgula.
		for (const value of [...list(process.env.FRONTEND_ORIGIN), process.env.API_PUBLIC_URL])
			if (!/^https:\/\/[^/]+$/.test(value)) throw new Error(`${value} deve ser uma URL https sem barra no final, por exemplo https://app.empresa.com.br.`);
		if (!config.cookieSecure) warnings.push("COOKIE_SECURE=false em producao: o cookie de sessao pode trafegar sem HTTPS.");
		if (!config.proxySharedSecret)
			warnings.push(
				"PROXY_SHARED_SECRET nao definida: acessos que passam pelo Nginx do frontend chegam todos com o IP dele, e o limite de 20 tentativas por IP vale para a empresa inteira. Defina o mesmo segredo na API e no frontend."
			);
	}
	if (process.env.SMTP_HOST && !process.env.MAIL_FROM) warnings.push("SMTP_HOST definido sem MAIL_FROM; usando o remetente padrao.");
	if (Boolean(process.env.WHATSAPP_TOKEN) !== Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID))
		warnings.push("WhatsApp precisa de WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID juntos; canal desligado.");
	if (isProduction && !process.env.SMTP_HOST) warnings.push("SMTP_HOST nao definido: convites, avisos e relatorios por e-mail ficam desligados.");
	if (config.encryptionKey) {
		const { decodeKey } = require("./security/crypto");
		decodeKey(config.encryptionKey);
	}
	if (!Number.isFinite(config.sessionDurationInDays) || config.sessionDurationInDays <= 0) throw new Error("SESSION_DURATION_DAYS invalido.");
	if (!Number.isFinite(config.sessionIdleMinutes) || config.sessionIdleMinutes <= 0) throw new Error("SESSION_IDLE_MINUTES invalido.");
	return warnings;
}

module.exports = { config, validateConfig };
