// Avisos por WhatsApp pela Cloud API oficial do Meta.
// Mensagens iniciadas pela empresa exigem um modelo aprovado no WhatsApp Manager com UM parametro no corpo,
// por exemplo: "PlanoPneumatic: {{1}}". Sem WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID o canal fica desligado.
const { logEvent } = require("../middleware/errors");

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v21.0";
let fetchImplementation = (...args) => fetch(...args);
function setTransport(next) { fetchImplementation = next; }

const isConfigured = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);

// Celular brasileiro -> formato internacional so com digitos (55 + DDD + numero).
function normalizePhone(value) {
	const digits = String(value || "").replace(/\D/g, "");
	if (digits.length === 10 || digits.length === 11) return `55${digits}`;
	if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) return digits;
	return null;
}

async function send(phone, text) {
	const to = normalizePhone(phone);
	if (!to) return { delivered: false, reason: "invalid_phone" };
	if (!isConfigured()) return { delivered: false, reason: "not_configured" };
	const response = await fetchImplementation(`https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
		method: "POST",
		headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			messaging_product: "whatsapp",
			to,
			type: "template",
			template: {
				name: process.env.WHATSAPP_TEMPLATE || "aviso_processo",
				language: { code: process.env.WHATSAPP_TEMPLATE_LANG || "pt_BR" },
				components: [{ type: "body", parameters: [{ type: "text", text: String(text).slice(0, 900) }] }]
			}
		}),
		signal: AbortSignal.timeout(15000)
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		const error = body.error?.message || `HTTP ${response.status}`;
		logEvent("whatsapp_error", { error });
		return { delivered: false, reason: error };
	}
	return { delivered: true };
}

module.exports = { send, isConfigured, normalizePhone, setTransport };
