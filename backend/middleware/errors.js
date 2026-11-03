const crypto = require("node:crypto");
const { z, ZodError } = require("zod");

// Mensagens padrao de validacao em portugues (as mensagens especificas dos schemas prevalecem).
z.config(z.locales.pt());

class AppError extends Error {
	constructor(status, message, code = "ERROR", details) {
		super(message);
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

const notFound = (message = "Registro nao encontrado.") => new AppError(404, message, "NOT_FOUND");
const badRequest = (message, code = "BAD_REQUEST", details) => new AppError(400, message, code, details);
const forbidden = (message = "Seu perfil nao possui esta permissao.") => new AppError(403, message, "FORBIDDEN");
const conflict = (message, code = "CONFLICT") => new AppError(409, message, code);

function logEvent(event, details = {}) {
	if (process.env.NODE_ENV === "test" && !process.env.LOG_IN_TESTS) return;
	console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

// Atribui um ID de correlacao a cada requisicao e o devolve no cabecalho X-Request-Id.
function requestId(request, response, next) {
	const incoming = String(request.get("x-request-id") || "");
	request.id = /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
	response.setHeader("X-Request-Id", request.id);
	return next();
}

function requestLogger(request, response, next) {
	const startedAt = process.hrtime.bigint();
	response.on("finish", () => {
		const path = request.originalUrl.split("?")[0];
		if (path === "/health" || path === "/api/health") return;
		logEvent("http_request", { requestId: request.id, method: request.method, path, status: response.statusCode, durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6 });
	});
	return next();
}

function formatZodIssues(error) {
	return error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(error, request, response, next) {
	if (error instanceof ZodError) {
		const issues = formatZodIssues(error);
		return response.status(400).json({ message: issues[0]?.message || "Dados invalidos.", code: "VALIDATION_ERROR", errors: issues, requestId: request.id });
	}
	if (error instanceof AppError) {
		return response.status(error.status).json({ message: error.message, code: error.code, ...(error.details ? { details: error.details } : {}), requestId: request.id });
	}
	if (error.type === "entity.too.large") {
		return response.status(413).json({ message: "Arquivo ou requisicao maior que o limite permitido.", code: "PAYLOAD_TOO_LARGE", requestId: request.id });
	}
	if (error.type === "entity.parse.failed") {
		return response.status(400).json({ message: "JSON invalido.", code: "BAD_JSON", requestId: request.id });
	}
	if (error.code === "23505") {
		return response.status(409).json({ message: "Ja existe um registro com estes dados.", code: "DUPLICATE", requestId: request.id });
	}
	logEvent("http_error", { requestId: request.id, method: request.method, path: request.path, error: error.message, stack: process.env.NODE_ENV === "production" ? undefined : error.stack });
	return response.status(500).json({ message: "Erro interno do servidor.", code: "INTERNAL", requestId: request.id });
}

// Encapsula handlers async para encaminhar excecoes ao errorHandler.
const wrap = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);

module.exports = { AppError, notFound, badRequest, forbidden, conflict, logEvent, requestId, requestLogger, errorHandler, wrap };
