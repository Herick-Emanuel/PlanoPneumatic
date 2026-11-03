const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const { config } = require("./config");
const { database } = require("./db");
const { securityHeaders, cors } = require("./middleware/security");
const { requestId, requestLogger, errorHandler } = require("./middleware/errors");
const metrics = require("./services/metrics");

const app = express();

app.use(requestId);
app.use(requestLogger);
app.use(metrics.metricsMiddleware);
app.use(securityHeaders);
app.use(cors);
app.use(express.json({ limit: "1mb" }));
// O service worker leva o ID do build: cada deploy invalida o cache do app.
app.get("/sw.js", (request, response) => {
	response.type("application/javascript").setHeader("Cache-Control", "no-cache");
	response.send(fs.readFileSync(path.join(config.frontendDirectory, "sw.js"), "utf8").replaceAll("__BUILD_ID__", config.buildId));
});
app.use(express.static(config.frontendDirectory));
app.use(express.static(path.join(config.frontendDirectory, "html")));
app.get("/api/openapi.yaml", (request, response) => response.type("text/yaml").send(fs.readFileSync(path.join(__dirname, "..", "docs", "openapi.yaml"), "utf8")));

async function health(request, response) {
	try {
		await database.query("SELECT 1");
		return response.json({ status: "ok", database: "ok" });
	} catch {
		return response.status(503).json({ status: "degraded", database: "unavailable" });
	}
}
app.get(["/health", "/api/health", "/health/db"], health);

// Metricas Prometheus: so respondem com METRICS_TOKEN configurado (Authorization: Bearer <token>).
app.get("/api/metrics", async (request, response, next) => {
	try {
		const token = process.env.METRICS_TOKEN;
		if (!token) return response.status(404).json({ message: "Rota nao encontrada." });
		if (request.get("authorization") !== `Bearer ${token}`) return response.status(401).json({ message: "Nao autorizado." });
		return response.type("text/plain; version=0.0.4").send(await metrics.render());
	} catch (error) { return next(error); }
});

app.use("/api/auth", require("./routes/auth").router);
app.use("/api/cases", require("./routes/cases").router);
app.use("/api/reports", require("./routes/reports").router);
app.use("/api/users", require("./routes/users").router);
app.use("/api", require("./routes/registry").router);
app.use("/api", require("./routes/system").router);
app.use("/api", (request, response) => response.status(404).json({ message: "Rota nao encontrada.", code: "NOT_FOUND", requestId: request.id }));

app.get("*", (request, response) => response.sendFile(path.join(config.frontendDirectory, "html", "index.html")));
app.use(errorHandler);

module.exports = { app };
