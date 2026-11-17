// Cifra de segredos guardados no banco (segredo de assinatura dos webhooks) com AES-256-GCM.
// Formato gravado: "enc:v1:<iv base64url>:<tag base64url>:<conteudo base64url>".
const crypto = require("node:crypto");

const PREFIX = "enc:v1:";
// Chave fixa e publica, usada SOMENTE fora de producao quando APP_ENCRYPTION_KEY nao foi definida
// (desenvolvimento e testes). Producao e homologacao recusam subir sem a chave (config.validateConfig).
const DEVELOPMENT_KEY = crypto.createHash("sha256").update("plano-pneumatic-development-only-key").digest();

function decodeKey(value) {
	const text = String(value || "").trim();
	let key = null;
	if (/^[0-9a-f]{64}$/i.test(text)) key = Buffer.from(text, "hex");
	else {
		try {
			key = Buffer.from(text, "base64");
		} catch {
			key = null;
		}
	}
	if (!key || key.length !== 32) throw new Error("APP_ENCRYPTION_KEY deve ter 32 bytes (64 caracteres hex ou 44 em base64).");
	return key;
}

let cachedKey = null;
function key() {
	if (cachedKey) return cachedKey;
	const configured = process.env.APP_ENCRYPTION_KEY;
	if (configured) cachedKey = decodeKey(configured);
	else if (["production", "staging"].includes(process.env.NODE_ENV)) throw new Error("APP_ENCRYPTION_KEY nao definida.");
	else cachedKey = DEVELOPMENT_KEY;
	return cachedKey;
}

const isEncrypted = (value) => typeof value === "string" && value.startsWith(PREFIX);

function encrypt(plain) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
	const content = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
	return `${PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${content.toString("base64url")}`;
}

// Aceita valores antigos em texto puro (anteriores a cifra) para a migracao gradual.
function decrypt(value) {
	if (!isEncrypted(value)) return value;
	const [iv, tag, content] = value.slice(PREFIX.length).split(":");
	const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
	decipher.setAuthTag(Buffer.from(tag, "base64url"));
	return Buffer.concat([decipher.update(Buffer.from(content, "base64url")), decipher.final()]).toString("utf8");
}

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function safeEqual(a, b) {
	const left = Buffer.from(String(a));
	const right = Buffer.from(String(b));
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = { encrypt, decrypt, isEncrypted, decodeKey, sha256, safeEqual };
