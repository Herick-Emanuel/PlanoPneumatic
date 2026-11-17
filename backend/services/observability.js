// Rastreamento de erros com Sentry (opcional: so liga com SENTRY_DSN) + registro no log JSON.
const { logEvent } = require("../middleware/errors");

let sentry = null;

function init({ release } = {}) {
	if (!process.env.SENTRY_DSN || sentry) return Boolean(sentry);
	sentry = require("@sentry/node");
	sentry.init({
		dsn: process.env.SENTRY_DSN,
		environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
		release,
		tracesSampleRate: 0,
		sendDefaultPii: false
	});
	logEvent("sentry_enabled", { environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV });
	return true;
}

const isEnabled = () => Boolean(sentry);

// Erro inesperado do servidor (as respostas 4xx de regra de negocio nao entram aqui).
function captureServerError(error, context = {}) {
	if (!sentry) return;
	sentry.withScope((scope) => {
		scope.setTag("requestId", context.requestId);
		scope.setContext("request", { method: context.method, path: context.path });
		if (context.userId) scope.setUser({ id: String(context.userId) });
		sentry.captureException(error);
	});
}

function captureClientError({ message, source, line, page, stack, userId, requestId }) {
	logEvent("client_error", { message, source, line, page, userId, requestId });
	if (!sentry) return;
	sentry.withScope((scope) => {
		scope.setTag("origin", "browser");
		scope.setContext("browser", { source, line, page, stack });
		if (userId) scope.setUser({ id: String(userId) });
		sentry.captureMessage(`[navegador] ${message}`, "error");
	});
}

async function flush() {
	if (sentry) await sentry.flush(2000).catch(() => {});
}

module.exports = { init, isEnabled, captureServerError, captureClientError, flush };
