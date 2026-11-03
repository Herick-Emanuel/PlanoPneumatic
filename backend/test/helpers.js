// Testes rodam contra um PostgreSQL real. Defina TEST_DATABASE_URL (o nome do banco deve conter "test").
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/plano_pneumatic_test";
process.env.NODE_ENV = "test";
process.env.DISABLE_WEBHOOKS = "true";
process.env.SEED_ADMIN_EMAIL = "seed-admin@test.local";
process.env.SEED_ADMIN_PASSWORD = "SeedPass123!";

const http = require("node:http");
const bcrypt = require("bcryptjs");
const { database, initializeDatabase } = require("../db");
const { createSession } = require("../middleware/auth");
const { app } = require("../app");

if (!/test/i.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error("Recusando rodar testes em um banco cujo nome nao contem 'test'.");

const passwordHash = bcrypt.hashSync("StrongPass123!", 4);
let server;
let baseUrl;

async function setup() {
	await initializeDatabase();
	server = http.createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function teardown() {
	await new Promise((resolve) => server.close(resolve));
	await database.end();
}

async function resetDatabase() {
	await database.query("TRUNCATE users, cases, customers, products, case_sequences, webhooks, case_sla_config, app_settings RESTART IDENTITY CASCADE");
	await database.query("INSERT INTO case_sla_config (type, days) VALUES ('Pedido de venda', 3), ('Base de troca', 5), ('Garantia', 7)");
	await database.query("INSERT INTO app_settings (key, value) VALUES ('alerts_enabled', 'true'), ('auto_refresh', 'true'), ('require_documents', 'true')");
}

let userCounter = 0;
async function createUser(role = "operator", overrides = {}) {
	userCounter += 1;
	const { rows } = await database.query(
		"INSERT INTO users (name, email, password_hash, role, manager_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role",
		[overrides.name || `${role} ${userCounter}`, overrides.email || `${role}${userCounter}@test.local`, passwordHash, role, overrides.managerId || null]
	);
	const session = await createSession(rows[0].id);
	return { ...rows[0], token: session.token };
}

async function api(method, path, { body, token, headers = {}, raw } = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: { ...(raw ? {} : body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
		body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
	});
	const contentType = response.headers.get("content-type") || "";
	let data = null;
	if (contentType.includes("application/json")) data = await response.json().catch(() => null);
	else if (contentType.startsWith("text/")) data = await response.text();
	else data = Buffer.from(await response.arrayBuffer());
	return { status: response.status, body: data, headers: response.headers };
}

const basePayload = (type = "Garantia", extra = {}) => ({
	type, client: "Cliente Teste", product: "Compressor", productCode: "CP-01", quantity: 1,
	...(type === "Base de troca" ? { exchangeReason: "Erro de pedido", itemCondition: "Perfeito estado" } : {}),
	...extra
});

async function createCase(token, type = "Garantia", extra = {}) {
	const response = await api("POST", "/api/cases", { token, body: basePayload(type, extra) });
	if (response.status !== 201) throw new Error(`createCase falhou: ${response.status} ${JSON.stringify(response.body)}`);
	return response.body.case.id;
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex");

module.exports = { setup, teardown, resetDatabase, createUser, api, basePayload, createCase, database, PNG };
