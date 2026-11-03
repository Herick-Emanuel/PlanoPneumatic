const assert = require("node:assert/strict");
const { before, after, beforeEach, test } = require("node:test");
const h = require("./helpers");

before(h.setup);
after(h.teardown);
beforeEach(h.resetDatabase);

test("login rejects invalid credentials", async () => {
	const response = await h.api("POST", "/api/auth/login", { body: { email: "unknown@example.com", password: "wrong" } });
	assert.equal(response.status, 401);
	assert.equal(response.body.message, "Usuario ou senha invalidos.");
});

test("login creates a session for valid credentials and me exposes capabilities", async () => {
	const admin = await h.createUser("admin", { email: "admin@example.com" });
	const login = await h.api("POST", "/api/auth/login", { body: { email: "admin@example.com", password: "StrongPass123!" } });
	assert.equal(login.status, 200);
	assert.equal(login.body.user.role, "admin");
	const me = await h.api("GET", "/api/auth/me", { token: login.body.token });
	assert.equal(me.status, 200);
	assert.ok(me.body.user.capabilities.includes("cases.decide"));
	assert.ok(admin.id);
});

test("requests without a session are rejected", async () => {
	assert.equal((await h.api("GET", "/api/cases")).status, 401);
	assert.equal((await h.api("GET", "/api/cases", { token: "bogus" })).status, 401);
});

test("operator cannot list users or assign cases", async () => {
	const operator = await h.createUser("operator");
	assert.equal((await h.api("GET", "/api/users", { token: operator.token })).status, 403);
	const caseNumber = await h.createCase(operator.token);
	const assign = await h.api("PATCH", `/api/cases/${caseNumber}/assignee`, { token: operator.token, body: { assignedTo: operator.id } });
	assert.equal(assign.status, 403);
});

test("manager can create an operator but not a manager; admin can create any non-admin role", async () => {
	const manager = await h.createUser("manager");
	const body = { name: "Novo", email: "novo@example.com", password: "StrongPass123!" };
	assert.equal((await h.api("POST", "/api/users", { token: manager.token, body: { ...body, role: "operator" } })).status, 201);
	assert.equal((await h.api("POST", "/api/users", { token: manager.token, body: { ...body, email: "outro@example.com", role: "manager" } })).status, 400);
	const admin = await h.createUser("admin");
	const created = await h.api("POST", "/api/users", { token: admin.token, body: { ...body, email: "tecnico@example.com", role: "technician" } });
	assert.equal(created.status, 201);
	assert.equal(created.body.user.role, "technician");
	const duplicate = await h.api("POST", "/api/users", { token: admin.token, body: { ...body, email: "tecnico@example.com", role: "operator" } });
	assert.equal(duplicate.status, 409);
});

test("admin edits a user's profile and resets the password", async () => {
	const admin = await h.createUser("admin");
	const operator = await h.createUser("operator");
	const edit = await h.api("PATCH", `/api/users/${operator.id}`, { token: admin.token, body: { name: "Renomeado", role: "logistics" } });
	assert.equal(edit.status, 200);
	assert.equal(edit.body.user.role, "logistics");
	assert.equal((await h.api("GET", "/api/auth/me", { token: operator.token })).status, 401, "mudar o perfil encerra as sessoes");
	assert.equal((await h.api("POST", `/api/users/${operator.id}/reset-password`, { token: admin.token, body: { password: "BrandNew123!" } })).status, 204);
	const login = await h.api("POST", "/api/auth/login", { body: { email: operator.email, password: "BrandNew123!" } });
	assert.equal(login.status, 200);
	const manager = await h.createUser("manager");
	assert.equal((await h.api("PATCH", `/api/users/${operator.id}`, { token: manager.token, body: { name: "x" } })).status, 403);
});

test("deactivating a user reassigns open cases and ends sessions", async () => {
	const admin = await h.createUser("admin");
	const manager = await h.createUser("manager");
	const operator = await h.createUser("operator", { managerId: manager.id });
	const caseNumber = await h.createCase(operator.token);
	const response = await h.api("PATCH", `/api/users/${operator.id}/status`, { token: admin.token, body: { active: false } });
	assert.equal(response.status, 200);
	assert.equal(response.body.reassignment.reassigned, 1);
	const detail = await h.api("GET", `/api/cases/${caseNumber}`, { token: admin.token });
	assert.equal(detail.body.case.assignedTo, manager.id);
	assert.equal((await h.api("GET", "/api/auth/me", { token: operator.token })).status, 401);
});
