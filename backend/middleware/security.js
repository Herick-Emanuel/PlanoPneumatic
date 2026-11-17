const net = require("node:net");
const helmet = require("helmet");
const { config } = require("../config");
const { safeEqual } = require("../security/crypto");

// CSP sem 'unsafe-inline' (nem em scripts nem em estilos): larguras/alturas dinamicas sao aplicadas via CSSOM
// (element.style), que a CSP permite. O navegador so conversa com a propria origem (o Nginx faz o proxy de /api).
const helmetMiddleware = helmet({
	contentSecurityPolicy: {
		useDefaults: false,
		directives: {
			defaultSrc: ["'self'"],
			scriptSrc: ["'self'"],
			styleSrc: ["'self'"],
			imgSrc: ["'self'", "data:", "blob:"],
			connectSrc: ["'self'"],
			fontSrc: ["'self'"],
			manifestSrc: ["'self'"],
			workerSrc: ["'self'"],
			frameSrc: ["'self'", "blob:"],
			objectSrc: ["'none'"],
			baseUri: ["'self'"],
			formAction: ["'self'"],
			frameAncestors: ["'none'"]
		}
	},
	// HSTS so faz sentido (e so e respeitado) em HTTPS; em desenvolvimento local ficaria preso no localhost.
	strictTransportSecurity: config.cookieSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
	referrerPolicy: { policy: "no-referrer" },
	crossOriginEmbedderPolicy: false,
	crossOriginResourcePolicy: { policy: "same-origin" },
	crossOriginOpenerPolicy: { policy: "same-origin" },
	xFrameOptions: { action: "deny" }
});

function securityHeaders(request, response, next) {
	response.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
	// Respostas da API com dados de clientes nunca devem ficar em cache compartilhado.
	if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
	return helmetMiddleware(request, response, next);
}

// O navegador fala com a API pela propria origem (proxy do Nginx); CORS fica restrito a origem do frontend
// e sem credenciais, entao uma pagina de outro site nunca recebe o cookie de sessao.
function cors(request, response, next) {
	const origin = request.get("origin");
	if (origin && config.frontendOrigins.includes(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
	response.setHeader("Vary", "Origin");
	response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id, X-File-Name, X-CSRF-Token");
	response.setHeader("Access-Control-Expose-Headers", "X-Request-Id, Content-Disposition");
	response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
	if (request.method === "OPTIONS") return response.sendStatus(204);
	return next();
}

const normalizeIp = (value) => String(value || "").trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");

// IP do cliente. O Nginx do frontend envia X-Real-IP junto com o segredo compartilhado (PROXY_SHARED_SECRET);
// sem o segredo, vale o calculo do Express a partir de X-Forwarded-For e do "trust proxy" (TRUST_PROXY).
// Um cliente que fale direto com a API nao consegue forjar o IP so mandando cabecalhos.
function clientIp(request) {
	if (config.proxySharedSecret) {
		const provided = request.get("x-proxy-secret");
		const forwarded = normalizeIp(request.get("x-real-ip"));
		if (provided && safeEqual(provided, config.proxySharedSecret) && net.isIP(forwarded)) return forwarded;
	}
	return normalizeIp(request.ip || request.socket?.remoteAddress);
}

// Protecao extra contra CSRF: requisicoes que alteram dados vindas de navegador precisam ter Origin conhecida.
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function allowedOrigins(request) {
	const self = `${request.protocol}://${request.get("host")}`;
	return new Set([...config.frontendOrigins, config.apiOrigin, self]);
}
function originCheck(request, response, next) {
	if (!UNSAFE_METHODS.has(request.method)) return next();
	const origin = request.get("origin");
	if (!origin) return next();
	if (allowedOrigins(request).has(origin)) return next();
	return response.status(403).json({ message: "Origem da requisicao nao permitida.", code: "ORIGIN_NOT_ALLOWED", requestId: request.id });
}

// Limite de tentativas em memoria por IP (primeira barreira; o limite por e-mail fica no banco).
const rateBuckets = new Map();
function rateLimit({ windowMs, max, name }) {
	return (request, response, next) => {
		const key = `${name || request.path}:${clientIp(request)}`;
		const now = Date.now();
		const hits = (rateBuckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
		if (hits.length >= max) {
			response.setHeader("Retry-After", String(Math.ceil((windowMs - (now - hits[0])) / 1000)));
			return response.status(429).json({ message: "Muitas tentativas. Aguarde alguns minutos e tente novamente.", code: "RATE_LIMITED", requestId: request.id });
		}
		hits.push(now);
		rateBuckets.set(key, hits);
		return next();
	};
}
const resetRateLimits = () => rateBuckets.clear();
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

// Faixas que nunca podem ser destino de webhook (SSRF): loopback, redes privadas, link-local (metadados de
// nuvem em 169.254.169.254), CGNAT, multicast, reservados e equivalentes IPv6.
const blockedRanges = new net.BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
	["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
	["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blockedRanges.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	["::", 96], ["::1", 128], ["64:ff9b::", 96], ["2001::", 32], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32], ["2002::", 16],
	["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
]) blockedRanges.addSubnet(network, prefix, "ipv6");

function isPrivateAddress(address) {
	const ip = normalizeIp(address);
	const family = net.isIP(ip);
	if (!family) return true;
	if (family === 6) {
		const mapped = ip.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (mapped) {
			const value = (parseInt(mapped[1], 16) << 16) + parseInt(mapped[2], 16);
			return isPrivateAddress([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join("."));
		}
		if (/^::ffff:/i.test(ip)) return true;
	}
	return blockedRanges.check(ip, family === 4 ? "ipv4" : "ipv6");
}

// Checagem do nome antes de resolver DNS (a checagem definitiva acontece no IP resolvido, na entrega).
function isPrivateHost(hostname) {
	const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
	if (net.isIP(host)) return isPrivateAddress(host);
	// Formas numericas que o resolvedor aceita como IP (ex.: 2130706433, 0x7f.1, 017700000001).
	if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f]+/i.test(host) || /^\d+$/.test(host)) return true;
	return false;
}

module.exports = { securityHeaders, cors, originCheck, clientIp, rateLimit, resetRateLimits, startRateLimitCleanup, isPrivateHost, isPrivateAddress };
