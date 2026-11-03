const { config } = require("../config");

const contentSecurityPolicy = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${config.apiOrigin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;

// Headers de seguranca (defesa extra, invisivel para o uso normal).
function securityHeaders(request, response, next) {
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("X-XSS-Protection", "0");
	response.setHeader("Content-Security-Policy", contentSecurityPolicy);
	return next();
}

function cors(request, response, next) {
	const origin = request.get("origin");
	if (origin === config.frontendOrigin) response.setHeader("Access-Control-Allow-Origin", origin);
	response.setHeader("Vary", "Origin");
	response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id, X-File-Name");
	response.setHeader("Access-Control-Expose-Headers", "X-Request-Id, Content-Disposition");
	response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
	if (request.method === "OPTIONS") return response.sendStatus(204);
	return next();
}

// Limite de tentativas em memoria (generoso: so pega abuso/brute force, usuario normal nunca encosta).
const rateBuckets = new Map();
function rateLimit({ windowMs, max }) {
	return (request, response, next) => {
		const ip = String(request.headers["x-real-ip"] || request.headers["x-forwarded-for"] || request.socket.remoteAddress || "").split(",")[0].trim();
		const key = `${request.path}:${ip}`;
		const now = Date.now();
		const hits = (rateBuckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
		if (hits.length >= max) {
			response.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
			return response.status(429).json({ message: "Muitas tentativas. Aguarde alguns minutos e tente novamente." });
		}
		hits.push(now);
		rateBuckets.set(key, hits);
		return next();
	};
}
function startRateLimitCleanup() {
	const timer = setInterval(() => {
		const now = Date.now();
		for (const [key, timestamps] of rateBuckets) {
			const kept = timestamps.filter((timestamp) => now - timestamp < 3600000);
			if (kept.length) rateBuckets.set(key, kept); else rateBuckets.delete(key);
		}
	}, 600000);
	if (typeof timer.unref === "function") timer.unref();
	return timer;
}

// Bloqueia envio de webhook para hosts internos (mitiga SSRF). Nota: nao resolve DNS, cobre apenas IPs/hostnames literais.
function isPrivateHost(hostname) {
	const host = String(hostname || "").toLowerCase();
	if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
	if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|\[::1\])/.test(host)) return true;
	const match = host.match(/^172\.(\d{1,3})\./);
	if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
	return false;
}

module.exports = { securityHeaders, cors, rateLimit, startRateLimitCleanup, isPrivateHost };
