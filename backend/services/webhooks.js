const crypto = require("node:crypto");
const dns = require("node:dns");
const https = require("node:https");
const net = require("node:net");
const { database } = require("../db");
const { isPrivateHost, isPrivateAddress } = require("../middleware/security");
const { logEvent } = require("../middleware/errors");
const { encrypt, decrypt, isEncrypted } = require("../security/crypto");

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 2000, 10000];
const WEBHOOK_EVENTS = Object.freeze(["case.created", "case.status_changed", "case.assigned"]);

// Resolve o DNS e recusa a conexao se QUALQUER endereco for interno. O mesmo resultado e usado para conectar,
// entao uma troca de DNS entre a checagem e a conexao (DNS rebinding) nao consegue desviar a entrega.
function safeLookup(hostname, options, callback) {
	const done = typeof options === "function" ? options : callback;
	const lookupOptions = typeof options === "object" && options ? options : {};
	dns.lookup(hostname, { all: true, family: lookupOptions.family || 0 }, (error, addresses) => {
		if (error) return done(error);
		const list = Array.isArray(addresses) ? addresses : [addresses];
		const blocked = list.find((entry) => isPrivateAddress(entry.address));
		if (!list.length || blocked) {
			const refused = new Error(`Destino bloqueado: ${hostname} resolve para endereco interno.`);
			refused.code = "WEBHOOK_PRIVATE_ADDRESS";
			return done(refused);
		}
		if (lookupOptions.all) return done(null, list);
		return done(null, list[0].address, list[0].family);
	});
}

// Validacao na criacao: HTTPS, sem usuario/senha na URL e sem host interno literal.
function validateEndpoint(value) {
	let target;
	try { target = new URL(String(value || "").trim()); } catch { return "Endpoint invalido."; }
	if (target.protocol !== "https:") return "O endpoint precisa usar HTTPS.";
	if (target.username || target.password) return "Nao inclua usuario ou senha na URL do webhook; use o segredo de assinatura.";
	if (isPrivateHost(target.hostname)) return "Endpoint aponta para um endereco interno e foi bloqueado.";
	return null;
}

// Checagem extra na criacao: se o nome ja resolve para IP interno, recusa logo (a entrega confere de novo).
function resolvesToPrivate(hostname) {
	return new Promise((resolve) => {
		if (net.isIP(hostname)) return resolve(isPrivateAddress(hostname));
		dns.lookup(hostname, { all: true }, (error, addresses) => resolve(!error && addresses.some((entry) => isPrivateAddress(entry.address))));
	});
}

function postJson(target, body, signature) {
	return new Promise((resolve, reject) => {
		// IP literal nao passa pelo lookup: confere aqui.
		const literal = target.hostname.replace(/^\[|\]$/g, "");
		if (net.isIP(literal) && isPrivateAddress(literal)) return reject(Object.assign(new Error("Destino bloqueado (host interno)"), { code: "WEBHOOK_PRIVATE_ADDRESS" }));
		const request = https.request({
			hostname: literal,
			port: target.port || 443,
			path: `${target.pathname}${target.search}`,
			method: "POST",
			lookup: safeLookup,
			// Redirecionamentos nao sao seguidos (https.request nao segue): um 3xx conta como falha.
			headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Webhook-Signature": signature, "User-Agent": "PlanoPneumatic-Webhook/1" }
		}, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode));
		});
		request.on("error", reject);
		request.setTimeout(5000, () => request.destroy(new Error("Webhook timeout")));
		request.end(body);
	});
}

async function recordDelivery(webhookId, event, attempt, { statusCode = null, success = false, error = null }) {
	await database.query("INSERT INTO webhook_deliveries (webhook_id, event, attempt, status_code, success, error) VALUES ($1, $2, $3, $4, $5, $6)", [webhookId, event, attempt, statusCode, success, error ? String(error).slice(0, 500) : null]).catch(() => {});
}

async function deliver(webhook, event, body, signature) {
	let target;
	try { target = new URL(webhook.endpoint_url); } catch { return recordDelivery(webhook.id, event, 1, { error: "URL invalida" }); }
	const problem = validateEndpoint(webhook.endpoint_url);
	if (problem) {
		logEvent("webhook_blocked", { webhookId: webhook.id, reason: problem });
		return recordDelivery(webhook.id, event, 1, { error: problem });
	}
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		if (RETRY_DELAYS_MS[attempt - 1]) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
		try {
			const statusCode = await postJson(target, body, signature);
			const success = statusCode >= 200 && statusCode < 300;
			await recordDelivery(webhook.id, event, attempt, { statusCode, success, error: success ? null : `HTTP ${statusCode}` });
			if (success) return;
		} catch (error) {
			logEvent("webhook_error", { webhookId: webhook.id, attempt, error: error.message });
			await recordDelivery(webhook.id, event, attempt, { error: error.message });
			// Destino interno nao muda com nova tentativa.
			if (error.code === "WEBHOOK_PRIVATE_ADDRESS") return;
		}
	}
}

// Dispara em segundo plano; falhas nunca afetam a requisicao que gerou o evento.
function dispatchWebhook(event, payload) {
	if (process.env.DISABLE_WEBHOOKS === "true") return;
	void (async () => {
		const { rows } = await database.query("SELECT id, endpoint_url, secret FROM webhooks WHERE active = TRUE AND events @> $1::jsonb", [JSON.stringify([event])]);
		for (const webhook of rows) {
			const body = JSON.stringify({ event, payload, sentAt: new Date().toISOString() });
			const signature = crypto.createHmac("sha256", decrypt(webhook.secret)).update(body).digest("hex");
			void deliver(webhook, event, body, signature);
		}
	})().catch((error) => logEvent("webhook_dispatch_error", { error: error.message }));
}

// Cifra segredos gravados antes da protecao (texto puro). Idempotente; roda na subida.
async function encryptLegacySecrets() {
	const { rows } = await database.query("SELECT id, secret FROM webhooks WHERE secret NOT LIKE 'enc:v1:%'");
	for (const row of rows) {
		if (isEncrypted(row.secret)) continue;
		await database.query("UPDATE webhooks SET secret = $1 WHERE id = $2 AND secret = $3", [encrypt(row.secret), row.id, row.secret]);
	}
	return rows.length;
}

module.exports = { dispatchWebhook, WEBHOOK_EVENTS, validateEndpoint, resolvesToPrivate, encryptLegacySecrets, safeLookup, postJson };
