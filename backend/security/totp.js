// TOTP (RFC 6238) com HMAC-SHA1, 6 digitos e passo de 30 s: compativel com Google Authenticator,
// Microsoft Authenticator, Authy, 1Password etc. Nao depende de servico externo.
const crypto = require("node:crypto");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
	let bits = 0;
	let value = 0;
	let output = "";
	for (const byte of buffer) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
	return output;
}

function base32Decode(text) {
	const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, "");
	let bits = 0;
	let value = 0;
	const bytes = [];
	for (const character of clean) {
		value = (value << 5) | ALPHABET.indexOf(character);
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(bytes);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const digest = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
	const offset = digest[digest.length - 1] & 15;
	const binary = digest.readUInt32BE(offset) & 0x7fffffff;
	return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * Confere o codigo aceitando um passo de tolerancia para cada lado (relogio do celular adiantado/atrasado).
 * Devolve o passo usado (para impedir reuso do mesmo codigo) ou null.
 */
function verify(secret, code, { now = Date.now(), lastUsedStep = null, window = 1 } = {}) {
	const normalized = String(code || "").replace(/\s/g, "");
	if (!/^\d{6}$/.test(normalized)) return null;
	const step = currentStep(now);
	for (let delta = -window; delta <= window; delta += 1) {
		const candidate = step + delta;
		if (lastUsedStep !== null && lastUsedStep !== undefined && candidate <= Number(lastUsedStep)) continue;
		if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, candidate)), Buffer.from(normalized))) return candidate;
	}
	return null;
}

function otpauthUri(secret, accountName, issuer = "Plano Pneumatic") {
	const label = encodeURIComponent(`${issuer}:${accountName}`);
	return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// Codigos de recuperacao (para quando o celular se perde): 10 codigos de uso unico no formato xxxxx-xxxxx.
function recoveryCodes(count = 10) {
	return Array.from({ length: count }, () => {
		const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
		return `${raw.slice(0, 5)}-${raw.slice(5)}`;
	});
}

const normalizeRecoveryCode = (code) => String(code || "").toLowerCase().replace(/[^a-z2-7]/g, "");

module.exports = { generateSecret, verify, codeAt, currentStep, otpauthUri, recoveryCodes, normalizeRecoveryCode, base32Encode, base32Decode };
