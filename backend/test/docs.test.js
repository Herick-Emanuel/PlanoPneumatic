const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { listRoutes, render } = require("../../scripts/generate-openapi");

test("docs/openapi.yaml esta sincronizado com as rotas e os schemas (rode npm run docs:api)", () => {
	const committed = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "openapi.yaml"), "utf8").replace(/\r\n/g, "\n");
	assert.equal(committed, render(), "openapi.yaml desatualizado");
});

test("todas as rotas da API aparecem na especificacao", () => {
	const spec = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "openapi.yaml"), "utf8");
	for (const route of listRoutes()) {
		assert.ok(spec.includes(`"${route.path}":`), `rota ${route.method} ${route.path} sem documentacao`);
	}
	assert.ok(listRoutes().length >= 60);
});
