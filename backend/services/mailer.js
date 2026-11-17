// E-mail por SMTP generico (Google Workspace, Microsoft 365, Amazon SES, SendGrid, Resend...).
// Sem SMTP_HOST configurado, nada e enviado: o envio fica registrado no log (e em `outbox` nos testes).
const nodemailer = require("nodemailer");
const { config } = require("../config");
const { logEvent } = require("../middleware/errors");

let transport = null;
const outbox = [];

const isConfigured = () => Boolean(process.env.SMTP_HOST);

function getTransport() {
	if (transport) return transport;
	const port = Number(process.env.SMTP_PORT || 587);
	transport = nodemailer.createTransport({
		host: process.env.SMTP_HOST,
		port,
		secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
		auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
		connectionTimeout: 15000
	});
	return transport;
}

// Permite trocar o transporte nos testes.
function setTransport(next) {
	transport = next;
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Layout unico dos e-mails: titulo, paragrafos e um botao opcional.
function layout({ title, lines, action }) {
	const body = lines.map((line) => `<p style="margin:0 0 12px;color:#3f5068;font-size:15px;line-height:1.55">${escapeHtml(line)}</p>`).join("");
	const button = action
		? `<p style="margin:20px 0"><a href="${escapeHtml(action.url)}" style="background:#0b2f5b;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px;display:inline-block">${escapeHtml(action.label)}</a></p><p style="margin:0;color:#5b6a7c;font-size:12.5px">Se o botão não abrir, copie este endereço: ${escapeHtml(action.url)}</p>`
		: "";
	const html = `<div style="background:#f2f5f9;padding:24px 12px;font-family:Segoe UI,Arial,sans-serif"><div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e1e7ef;border-radius:12px;padding:24px"><p style="margin:0 0 6px;color:#1d6fd6;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">PlanoPneumatic</p><h1 style="margin:0 0 16px;color:#12233a;font-size:20px">${escapeHtml(title)}</h1>${body}${button}</div></div>`;
	const text = [title, "", ...lines, ...(action ? ["", `${action.label}: ${action.url}`] : [])].join("\n");
	return { html, text };
}

async function send({ to, subject, title, lines, action, attachments }) {
	const { html, text } = layout({ title: title || subject, lines, action });
	const message = { from: process.env.MAIL_FROM || "PlanoPneumatic <no-reply@planopneumatic.com.br>", to, subject, html, text, attachments };
	if (process.env.NODE_ENV === "test") {
		outbox.push(message);
		return { delivered: true, test: true };
	}
	if (!isConfigured()) {
		logEvent("mail_not_configured", { to, subject });
		return { delivered: false, reason: "not_configured" };
	}
	await getTransport().sendMail(message);
	logEvent("mail_sent", { to, subject });
	return { delivered: true };
}

const appUrl = (path = "/") => `${(process.env.APP_PUBLIC_URL || config.frontendOrigin).replace(/\/$/, "")}${path}`;

module.exports = { send, isConfigured, setTransport, outbox, appUrl, layout };
