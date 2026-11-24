const { config, validateConfig } = require("./config");
const { database, initializeDatabase } = require("./db");
const { app } = require("./app");
const { roles } = require("./domain/constants");
const { hasRole } = require("./domain/permissions");
const { logEvent } = require("./middleware/errors");
const { startRateLimitCleanup } = require("./middleware/security");
const { startSlaScheduler } = require("./services/sla");
const { startOmieScheduler } = require("./services/omie");
const { startHousekeeping } = require("./services/housekeeping");
const { encryptLegacySecrets } = require("./services/webhooks");
const { startReportScheduler } = require("./services/reportSchedules");
const observability = require("./services/observability");

async function start() {
	observability.init({ release: config.buildId });
	for (const warning of validateConfig()) logEvent("config_warning", { warning });
	await initializeDatabase();
	const encrypted = await encryptLegacySecrets();
	if (encrypted) logEvent("webhook_secrets_encrypted", { count: encrypted });
	startRateLimitCleanup();
	startHousekeeping();
	startSlaScheduler(config.slaCheckIntervalMs);
	startOmieScheduler();
	require("./services/omie").onSchedulerTick(require("./services/omieProducts").retryDue);
	startReportScheduler();
	require("./services/carcass").startCarcassScheduler();
	const server = app.listen(config.port, config.host, () => logEvent("server_started", { host: config.host, port: config.port }));

	let shuttingDown = false;
	const shutdown = (signal) => {
		if (shuttingDown) return;
		shuttingDown = true;
		logEvent("server_shutdown", { signal });
		const force = setTimeout(() => process.exit(1), 10000);
		force.unref();
		server.close(async () => {
			await observability.flush();
			await database.end().catch(() => {});
			process.exit(0);
		});
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
	return server;
}

if (require.main === module)
	start().catch((error) => {
		logEvent("startup_error", { error: error.message });
		process.exit(1);
	});

module.exports = { app, roles, hasRole, start, database };
