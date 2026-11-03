// Gera docs/openapi.yaml a partir das rotas registradas e dos schemas Zod (uma unica fonte de verdade).
// Uso: npm run docs:api   (o teste backend/test/docs.test.js falha se o arquivo estiver desatualizado)
process.env.NODE_ENV = process.env.NODE_ENV || "test";
const fs = require("node:fs");
const path = require("node:path");
const { z } = require("zod");

const mounts = [
	["/api/auth", "../backend/routes/auth", "Autenticacao"],
	["/api/cases", "../backend/routes/cases", "Processos"],
	["/api/reports", "../backend/routes/reports", "Relatorios"],
	["/api/users", "../backend/routes/users", "Usuarios"],
	["/api/omie", "../backend/routes/omie", "Omie"],
	["/api", "../backend/routes/registry", "Cadastros"],
	["/api", "../backend/routes/system", "Sistema"]
];

function listRoutes() {
	const routes = [];
	for (const [prefix, modulePath, tag] of mounts) {
		const { router } = require(modulePath);
		for (const layer of router.stack) {
			if (!layer.route) continue;
			for (const method of Object.keys(layer.route.methods)) {
				routes.push({ method, path: `${prefix}${layer.route.path === "/" ? "" : layer.route.path}`.replace(/:([A-Za-z]+)/g, "{$1}"), tag });
			}
		}
	}
	return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

const PUBLIC = new Set(["post /api/auth/login", "post /api/auth/forgot-password", "post /api/auth/reset-password", "get /api/meta"]);

function schemaOf(schema) {
	const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
	delete json.$schema;
	return json;
}

function buildSpec() {
	const caseSchemas = require("../backend/validators/cases");
	const bodies = {
		"post /api/cases": caseSchemas.createCaseSchema,
		"patch /api/cases/{caseNumber}": caseSchemas.updateCaseSchema,
		"patch /api/cases/{caseNumber}/status": caseSchemas.statusSchema
	};
	const queries = { "get /api/cases": caseSchemas.listQuerySchema };
	const paths = {};
	for (const route of listRoutes()) {
		const key = `${route.method} ${route.path}`;
		const parameters = [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => ({ name: match[1], in: "path", required: true, schema: { type: "string" } }));
		if (queries[key]) {
			const properties = schemaOf(queries[key]).properties || {};
			for (const [name, property] of Object.entries(properties)) parameters.push({ name, in: "query", required: false, schema: property });
		}
		const operation = {
			tags: [route.tag],
			summary: `${route.method.toUpperCase()} ${route.path}`,
			...(PUBLIC.has(key) ? { security: [] } : {}),
			...(parameters.length ? { parameters } : {}),
			...(bodies[key] ? { requestBody: { required: true, content: { "application/json": { schema: schemaOf(bodies[key]) } } } } : {}),
			responses: {
				200: { description: "Sucesso" },
				400: { description: "Dados invalidos (code VALIDATION_ERROR, errors[])" },
				401: { description: "Sessao invalida ou expirada" },
				403: { description: "Perfil sem permissao" },
				422: { description: "Regra de negocio violada (transicao, checklist, documentos)" }
			}
		};
		(paths[route.path] ||= {})[route.method] = operation;
	}
	return {
		openapi: "3.0.3",
		info: { title: "Plano Pneumatic API", version: "1.0.0", description: "Gerado por scripts/generate-openapi.js. Todas as rotas (exceto as marcadas como publicas) exigem Authorization: Bearer <token>." },
		components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
		security: [{ bearerAuth: [] }],
		paths
	};
}

function toYaml(value, indent = 0) {
	const pad = "  ".repeat(indent);
	if (Array.isArray(value)) {
		if (!value.length) return "[]";
		return value.map((item) => (item && typeof item === "object" ? `${pad}- ${toYaml(item, indent + 1).trimStart()}` : `${pad}- ${JSON.stringify(item)}`)).join("\n");
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value);
		if (!entries.length) return "{}";
		return entries.map(([key, entry]) => {
			const name = /^[A-Za-z0-9_$-]+$/.test(key) || /^\//.test(key) ? JSON.stringify(key) : JSON.stringify(key);
			if (entry && typeof entry === "object" && (Array.isArray(entry) ? entry.length : Object.keys(entry).length)) return `${pad}${name}:\n${toYaml(entry, indent + 1)}`;
			return `${pad}${name}: ${entry && typeof entry === "object" ? (Array.isArray(entry) ? "[]" : "{}") : JSON.stringify(entry)}`;
		}).join("\n");
	}
	return `${pad}${JSON.stringify(value)}`;
}

function render() {
	return `# Gerado por scripts/generate-openapi.js - nao edite manualmente (npm run docs:api).\n${toYaml(buildSpec())}\n`;
}

module.exports = { listRoutes, buildSpec, render };

if (require.main === module) {
	fs.writeFileSync(path.join(__dirname, "..", "docs", "openapi.yaml"), render());
	console.log(`docs/openapi.yaml gerado com ${listRoutes().length} rotas.`);
}
