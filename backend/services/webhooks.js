const crypto = require("node:crypto");
const https = require("node:https");
const { database } = require("../db");
const { isPrivateHost } = require("../middleware/security");
const { logEvent } = require("../middleware/errors");

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 2000, 10000];
const WEBHOOK_EVENTS = Object.freeze(["case.created", "case.status_changed", "case.assigned"]);

function postJson(target, body, signature) {
	return new Promise((resolve, reject) => {
		const request = https.request({
			hostname: target.hostname,
			port: target.port || 443,
			path: `${target.pathname}${target.search}`,
			method: "POST",
			headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Webhook-Signature": signature }
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
	await database.query("INSERT INTO webhook_deliveries (webhook_id, event, attempt, status_code, success, error) VALUES ($1, $2, $3, $4, $5, $6)", [webhookId, event, attempt, statusCode, success, error]).catch(() => {});
}

async function deliver(webhook, event, body, signature) {
	let target;
	try { target = new URL(webhook.endpoint_url); } catch { return recordDelivery(webhook.id, event, 1, { error: "URL invalida" }); }
	if (isPrivateHost(target.hostname)) {
		logEvent("webhook_blocked_private_host", { endpoint: webhook.endpoint_url });
		return recordDelivery(webhook.id, event, 1, { error: "Destino bloqueado (host interno)" });
	}
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		if (RETRY_DELAYS_MS[attempt - 1]) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
		try {
			const statusCode = await postJson(target, body, signature);
			const success = statusCode >= 200 && statusCode < 300;
			await recordDelivery(webhook.id, event, attempt, { statusCode, success, error: success ? null : `HTTP ${statusCode}` });
			if (success) return;
		} catch (error) {
			logEvent("webhook_error", { endpoint: webhook.endpoint_url, attempt, error: error.message });
			await recordDelivery(webhook.id, event, attempt, { error: error.message });
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
			const signature = crypto.createHmac("sha256", webhook.secret).update(body).digest("hex");
			void deliver(webhook, event, body, signature);
		}
	})().catch((error) => logEvent("webhook_dispatch_error", { error: error.message }));
}

module.exports = { dispatchWebhook, WEBHOOK_EVENTS };
