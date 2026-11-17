// Secao 2 do escopo (seguranca): sessao em cookie + CSRF, limite de login, senhas, isolamento por time,
// SSRF de webhooks, cabecalhos, auditoria, sessoes e MFA.
const assert = require("node:assert/strict");
const { before, after, beforeEach, test } = require("node:test");
const h = require("./helpers");
const { passwordProblem, validateSeedPasswords } = require("../security/passwords");
const { encrypt, decrypt } = require("../security/crypto");
const totp = require("../security/totp");
const { isPrivateAddress, isPrivateHost } = require("../middleware/security");
const { validateEndpoint, encryptLegacySecrets, safeLookup } = require("../services/webhooks");
const { runHousekeeping } = require("../services/housekeeping");
const settings = require("../services/settings");

before(h.setup);
after(h.teardown);
beforeEach(h.resetDatabase);

const setSetting = async (key, value) => {
	await h.database.query("UPDATE app_settings SET value = $2::jsonb WHERE key = $1", [key, JSON.stringify(value)]);
	settings.invalidate();
};

// ------------------------------------------------------------------ P0: sessao em cookie + CSRF
test("login grava a sessao em cookie HttpOnly/SameSite=Strict e nao devolve o token no corpo", async () => {
	const admin = await h.createUser("admin");
	const { response, cookies } = await h.loginWithCookies(admin.email);
	assert.equal(response.status, 200);
	assert.equal(response.body.token, undefined);
	const sessionCookie = cookies.raw.find((value) => value.startsWith("pp_session="));
	const csrfCookie = cookies.raw.find((value) => value.startsWith("pp_csrf="));
	assert.match(sessionCookie, /HttpOnly/);
	assert.match(sessionCookie, /SameSite=Strict/);
	assert.match(sessionCookie, /Path=\//);
	assert.doesNotMatch(csrfCookie, /HttpOnly/, "o cookie CSRF precisa ser legivel pelo frontend");
	assert.equal(response.body.csrfToken, cookies.csrf);
	assert.equal((await h.api("GET", "/api/auth/me", { cookies })).status, 200);
});

test("alteracoes com cookie exigem X-CSRF-Token valido; Bearer nao precisa", async () => {
	const operator = await h.createUser("operator");
	const { cookies } = await h.loginWithCookies(operator.email);
	const payload = h.basePayload();
	const missing = await h.api("POST", "/api/cases", { cookies, csrf: false, body: payload });
	assert.equal(missing.status, 403);
	assert.equal(missing.body.code, "CSRF_INVALID");
	const wrong = await h.api("POST", "/api/cases", { cookies, csrf: false, headers: { "X-CSRF-Token": "x".repeat(43) }, body: payload });
	assert.equal(wrong.body.code, "CSRF_INVALID");
	assert.equal((await h.api("POST", "/api/cases", { cookies, body: payload })).status, 201);
	assert.equal((await h.api("GET", "/api/cases", { cookies, csrf: false })).status, 200, "leitura nao exige CSRF");
	assert.equal((await h.api("POST", "/api/cases", { token: operator.token, body: payload })).status, 201);
});

test("requisicao que altera dados vinda de outra origem e recusada", async () => {
	const operator = await h.createUser("operator");
	const { cookies } = await h.loginWithCookies(operator.email);
	const response = await h.api("POST", "/api/cases", { cookies, headers: { Origin: "https://site-malicioso.example" }, body: h.basePayload() });
	assert.equal(response.status, 403);
	assert.equal(response.body.code, "ORIGIN_NOT_ALLOWED");
	const loginCsrf = await h.api("POST", "/api/auth/login", { headers: { Origin: "https://site-malicioso.example" }, body: { email: operator.email, password: h.PASSWORD } });
	assert.equal(loginCsrf.status, 403, "login CSRF tambem e bloqueado");
	assert.equal((await h.api("POST", "/api/cases", { cookies, headers: { Origin: h.baseUrl() }, body: h.basePayload() })).status, 201);
});

test("logout limpa os cookies e invalida a sessao no servidor", async () => {
	const operator = await h.createUser("operator");
	const { cookies } = await h.loginWithCookies(operator.email);
	const logout = await h.api("POST", "/api/auth/logout", { cookies });
	assert.equal(logout.status, 204);
	assert.ok(h.readCookies(logout).raw.some((value) => value.startsWith("pp_session=;") && /Max-Age=0/.test(value)));
	assert.equal((await h.api("GET", "/api/auth/me", { cookies })).status, 401);
	assert.equal((await h.api("POST", "/api/auth/logout")).status, 204, "sair sem sessao nao falha");
});

// ------------------------------------------------------------------ P0: limite de login
test("cinco falhas bloqueiam o e-mail (mesmo com a senha certa) e a resposta e igual para e-mail inexistente", async () => {
	const operator = await h.createUser("operator");
	for (const email of [operator.email, "naoexiste@test.local"]) {
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			const response = await h.api("POST", "/api/auth/login", { body: { email, password: "senha-errada-qualquer" } });
			assert.equal(response.status, 401, `tentativa ${attempt}`);
		}
		const fifth = await h.api("POST", "/api/auth/login", { body: { email, password: "senha-errada-qualquer" } });
		assert.equal(fifth.status, 429);
		assert.equal(fifth.body.code, "LOGIN_LOCKED");
		assert.ok(Number(fifth.headers.get("retry-after")) > 0);
	}
	const correct = await h.api("POST", "/api/auth/login", { body: { email: operator.email, password: h.PASSWORD } });
	assert.equal(correct.status, 429, "bloqueado mesmo com a senha certa");
	// Bloqueio progressivo: a proxima falha depois do bloqueio dobra o tempo.
	await h.database.query("UPDATE login_throttle SET locked_until = NOW() - INTERVAL '1 second'");
	const sixth = await h.api("POST", "/api/auth/login", { body: { email: operator.email, password: "senha-errada-qualquer" } });
	assert.equal(sixth.status, 429);
	assert.ok(Number(sixth.headers.get("retry-after")) > 60);
	// Login correto depois do bloqueio zera o contador.
	await h.database.query("UPDATE login_throttle SET locked_until = NULL");
	assert.equal((await h.api("POST", "/api/auth/login", { body: { email: operator.email, password: h.PASSWORD } })).status, 200);
	const { rows } = await h.database.query("SELECT COUNT(*)::int AS count FROM login_throttle WHERE email_hash = encode(sha256($1::bytea), 'hex')", [operator.email]);
	assert.equal(rows[0].count, 0, "acerto apaga os contadores do e-mail");
	const stored = await h.database.query("SELECT throttle_key, email_hash FROM login_throttle");
	assert.ok(stored.rows.length >= 1 && stored.rows.every((row) => !row.email_hash.includes("@")), "a tabela guarda so hashes");
});

test("tentativas em paralelo nao passam do limite (reserva atomica) no login e no MFA", async () => {
	const operator = await h.createUser("operator");
	const results = await Promise.all(Array.from({ length: 15 }, () => h.api("POST", "/api/auth/login", { body: { email: operator.email, password: "senha-errada-qualquer" } })));
	const evaluated = results.filter((response) => response.status === 401 || (response.status === 429 && response.body.code === "LOGIN_LOCKED")).length;
	assert.equal(results.filter((response) => response.status === 401).length, 4, "so 4 tentativas erradas sao avaliadas antes do bloqueio");
	assert.equal(evaluated, 15);
	const { rows } = await h.database.query("SELECT MAX(failed_count)::int AS count FROM login_throttle");
	assert.ok(rows[0].count <= 5, `contador ${rows[0].count}: nenhuma tentativa alem do limite foi conferida`);

	// MFA: 12 codigos em paralelo contra o mesmo desafio -> no maximo 5 conferidos.
	const admin = await h.createUser("admin");
	const { cookies } = await h.loginWithCookies(admin.email);
	await enrollMfa(cookies);
	h.resetRateLimitsForTest();
	const login = await h.api("POST", "/api/auth/login", { body: { email: admin.email, password: h.PASSWORD } });
	await Promise.all(Array.from({ length: 12 }, () => h.api("POST", "/api/auth/mfa/verify", { body: { challenge: login.body.challenge, code: "111111" } })));
	const { rows: challenges } = await h.database.query("SELECT attempts FROM mfa_challenges WHERE user_id = $1", [admin.id]);
	assert.ok(challenges[0].attempts <= 5, `desafio com ${challenges[0].attempts} tentativas`);
});

test("aparelho conhecido entra mesmo com o e-mail sob ataque distribuido; administrador desbloqueia", async () => {
	const admin = await h.createUser("admin");
	const target = await h.createUser("operator");
	const first = await h.loginWithCookies(target.email);
	const device = first.cookies.raw.find((value) => value.startsWith("pp_device="));
	assert.match(device, /HttpOnly/);
	const deviceCookie = device.split(";")[0];
	// Ataque de varios IPs: trava a chave "so e-mail".
	await h.database.query("UPDATE login_throttle SET failed_count = 0");
	await h.database.query(
		"INSERT INTO login_throttle (throttle_key, email_hash, failed_count, last_failed_at, locked_until) VALUES (encode(sha256(('email:' || $1)::bytea), 'hex'), encode(sha256($1::bytea), 'hex'), 40, NOW(), NOW() + INTERVAL '1 hour')",
		[target.email]
	);
	const stranger = await h.api("POST", "/api/auth/login", { body: { email: target.email, password: h.PASSWORD } });
	assert.equal(stranger.status, 429, "aparelho desconhecido continua bloqueado");
	const known = await h.api("POST", "/api/auth/login", { headers: { Cookie: deviceCookie }, body: { email: target.email, password: h.PASSWORD } });
	assert.equal(known.status, 200, "o dono da conta, no aparelho de sempre, entra");
	await h.database.query(
		"INSERT INTO login_throttle (throttle_key, email_hash, failed_count, last_failed_at, locked_until) VALUES (encode(sha256(('email:' || $1)::bytea), 'hex'), encode(sha256($1::bytea), 'hex'), 40, NOW(), NOW() + INTERVAL '1 hour') ON CONFLICT (throttle_key) DO UPDATE SET locked_until = EXCLUDED.locked_until",
		[target.email]
	);
	const unlock = await h.api("POST", `/api/users/${target.id}/unlock-login`, { token: admin.token });
	assert.equal(unlock.status, 200);
	assert.ok(unlock.body.cleared >= 1);
	assert.equal((await h.api("POST", "/api/auth/login", { body: { email: target.email, password: h.PASSWORD } })).status, 200);
});

test("limite por IP nao e burlado trocando X-Real-IP / X-Forwarded-For sem o segredo do proxy", async () => {
	let last;
	for (let attempt = 0; attempt < 21; attempt += 1) {
		last = await h.api("POST", "/api/auth/login", { headers: { "X-Real-IP": `203.0.113.${attempt}`, "X-Forwarded-For": `198.51.100.${attempt}` }, body: { email: `pessoa${attempt}@test.local`, password: "x" } });
	}
	assert.equal(last.status, 429);
	assert.equal(last.body.code, "RATE_LIMITED");
});

// ------------------------------------------------------------------ P0/P1: senhas
test("politica de senha: 12+ caracteres, sem senhas comuns, exemplos ou dados do usuario", () => {
	assert.match(passwordProblem("Curta1!"), /12 caracteres/);
	for (const weak of ["Admin123!", "Password1234", "senha1234567", "P@ssw0rd2026!", "Operador123!", "aaaaaaaaaaaaaa", "123456789012", "<strong-secret>", "planopneumatic2026"]) {
		assert.ok(passwordProblem(weak), `${weak} deveria ser recusada`);
	}
	assert.match(passwordProblem("Joaquim-Silva-2026", { email: "joaquim@empresa.com", name: "Joaquim Silva" }), /nome|e-mail/);
	assert.equal(passwordProblem("Pneu-Recauchutado-Azul-77"), null);
	assert.equal(passwordProblem("correto cavalo bateria grampo"), null);
	assert.match(passwordProblem("á".repeat(40)), /72 bytes/);
});

test("subida recusa senha de seed fraca ou de exemplo", () => {
	assert.throws(() => validateSeedPasswords({ SEED_ADMIN_PASSWORD: "Admin123!", SEED_ADMIN_EMAIL: "admin@x.com" }), /SEED_ADMIN_PASSWORD recusada/);
	assert.throws(() => validateSeedPasswords({ SEED_ADMIN_PASSWORD: "<strong-secret>" }), /recusada/);
	assert.throws(() => validateSeedPasswords({ SEED_ADMIN_PASSWORD: "Pneu-Recauchutado-Azul-77", SEED_OPERATOR_PASSWORD: "Operador123!" }), /SEED_OPERATOR_PASSWORD/);
	assert.doesNotThrow(() => validateSeedPasswords({ SEED_ADMIN_PASSWORD: "Pneu-Recauchutado-Azul-77", SEED_ADMIN_EMAIL: "admin@x.com" }));
	assert.doesNotThrow(() => validateSeedPasswords({}));
});

test("usuario criado pelo administrador troca a senha no primeiro acesso antes de usar o sistema", async () => {
	const admin = await h.createUser("admin");
	const weak = await h.api("POST", "/api/users", { token: admin.token, body: { name: "Nova Pessoa", email: "nova@test.local", password: "Senha12345!", role: "operator" } });
	assert.equal(weak.status, 400);
	assert.equal(weak.body.code, "WEAK_PASSWORD");
	assert.equal((await h.api("POST", "/api/users", { token: admin.token, body: { name: "Nova Pessoa", email: "nova@test.local", password: "Inicial-Provisoria-Laranja-3", role: "operator" } })).status, 201);
	const { response, cookies } = await h.loginWithCookies("nova@test.local", "Inicial-Provisoria-Laranja-3");
	assert.equal(response.body.user.mustChangePassword, true);
	const blocked = await h.api("GET", "/api/cases", { cookies });
	assert.equal(blocked.status, 403);
	assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");
	assert.equal((await h.api("GET", "/api/auth/me", { cookies })).body.user.mustChangePassword, true);
	const wrongCurrent = await h.api("POST", "/api/auth/change-password", { cookies, body: { currentPassword: "errada", newPassword: "Freio-Disco-Traseiro-2031" } });
	assert.equal(wrongCurrent.body.code, "INVALID_CURRENT_PASSWORD");
	const same = await h.api("POST", "/api/auth/change-password", { cookies, body: { currentPassword: "Inicial-Provisoria-Laranja-3", newPassword: "Inicial-Provisoria-Laranja-3" } });
	assert.equal(same.status, 400);
	const changed = await h.api("POST", "/api/auth/change-password", { cookies, body: { currentPassword: "Inicial-Provisoria-Laranja-3", newPassword: "Freio-Disco-Traseiro-2031" } });
	assert.equal(changed.status, 200);
	assert.equal((await h.api("GET", "/api/cases", { cookies })).status, 200, "a sessao atual continua valida");
});

test("trocar a senha exige a senha atual e encerra as outras sessoes", async () => {
	const operator = await h.createUser("operator");
	const first = await h.loginWithCookies(operator.email);
	const second = await h.loginWithCookies(operator.email);
	const noCurrent = await h.api("PATCH", "/api/account", { cookies: first.cookies, body: { name: "Operador", password: "Freio-Disco-Traseiro-2031" } });
	assert.equal(noCurrent.status, 400);
	assert.equal(noCurrent.body.code, "INVALID_CURRENT_PASSWORD");
	const ok = await h.api("PATCH", "/api/account", { cookies: first.cookies, body: { name: "Operador", currentPassword: h.PASSWORD, password: "Freio-Disco-Traseiro-2031" } });
	assert.equal(ok.status, 200);
	assert.equal((await h.api("GET", "/api/auth/me", { cookies: first.cookies })).status, 200);
	assert.equal((await h.api("GET", "/api/auth/me", { cookies: second.cookies })).status, 401, "a outra sessao foi encerrada");
	assert.equal((await h.api("GET", "/api/auth/me", { token: operator.token })).status, 401);
});

test("senha provisoria do administrador segue a politica e obriga a troca", async () => {
	const admin = await h.createUser("admin");
	const operator = await h.createUser("operator");
	assert.equal((await h.api("POST", `/api/users/${operator.id}/reset-password`, { token: admin.token, body: { password: "12345678" } })).status, 400);
	assert.equal((await h.api("POST", `/api/users/${operator.id}/reset-password`, { token: admin.token, body: { password: "Senha-Provisoria-Cinza-48" } })).status, 204);
	const { response } = await h.loginWithCookies(operator.email, "Senha-Provisoria-Cinza-48");
	assert.equal(response.body.user.mustChangePassword, true);
});

// ------------------------------------------------------------------ P1: isolamento por time
test("gerente com escopo de time ve so os processos do proprio time", async () => {
	const managerA = await h.createUser("manager");
	const managerB = await h.createUser("manager");
	const operatorA = await h.createUser("operator", { managerId: managerA.id });
	const operatorB = await h.createUser("operator", { managerId: managerB.id });
	const caseA = await h.createCase(operatorA.token);
	const caseB = await h.createCase(operatorB.token);
	const list = async (user) => (await h.api("GET", "/api/cases", { token: user.token })).body.cases.map((item) => item.id).sort();
	assert.deepEqual(await list(managerA), [caseA, caseB].sort(), "desligado: ve tudo (comportamento anterior)");
	await setSetting("manager_team_scope", true);
	assert.deepEqual(await list(managerA), [caseA]);
	assert.equal((await h.api("GET", `/api/cases/${caseB}`, { token: managerA.token })).status, 404);
	assert.equal((await h.api("GET", `/api/cases/${caseA}`, { token: managerA.token })).status, 200);
	assert.equal((await h.api("GET", `/api/search?q=${caseB}`, { token: managerA.token })).body.cases.length, 0);
	const summary = await h.api("GET", "/api/reports/summary", { token: managerA.token });
	assert.equal(summary.status, 200);
	const admin = await h.createUser("admin");
	assert.equal((await list(admin)).length, 2, "administrador continua vendo tudo");
});

test("gerente so administra usuarios do proprio time e nunca administradores", async () => {
	const admin = await h.createUser("admin");
	const manager = await h.createUser("manager");
	const mine = await h.createUser("operator", { managerId: manager.id });
	const other = await h.createUser("operator");
	assert.equal((await h.api("PATCH", `/api/users/${admin.id}/status`, { token: manager.token, body: { active: false } })).status, 403);
	assert.equal((await h.api("PATCH", `/api/users/${other.id}/status`, { token: manager.token, body: { active: false } })).status, 403);
	assert.equal((await h.api("PATCH", `/api/users/${mine.id}/status`, { token: manager.token, body: { active: false } })).status, 200);
	const users = await h.api("GET", "/api/users", { token: manager.token });
	assert.deepEqual(users.body.users.map((user) => user.id).sort(), [manager.id, mine.id].sort());
	assert.equal((await h.api("PUT", "/api/settings/manager_team_scope", { token: manager.token, body: { value: true } })).status, 403, "configuracao de seguranca e so do administrador");
	assert.equal((await h.api("PUT", "/api/settings/auto_refresh", { token: manager.token, body: { value: false } })).status, 200);
	assert.equal((await h.api("PUT", "/api/settings/manager_team_scope", { token: admin.token, body: { value: true } })).status, 200);
	for (const key of ["constructor", "hasOwnProperty", "__proto__"]) assert.equal((await h.api("PUT", `/api/settings/${key}`, { token: admin.token, body: { value: true } })).status, 400, key);
});

// ------------------------------------------------------------------ P1: webhooks (SSRF + segredo cifrado)
test("enderecos internos sao bloqueados em qualquer forma", () => {
	for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "::7f00:1", "::127.0.0.1", "2001:0:4136:e378::1"]) {
		assert.equal(isPrivateAddress(address), true, address);
	}
	for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPrivateAddress(address), false, address);
	for (const host of ["localhost", "api.railway.internal", "2130706433", "0x7f000001", "017700000001", "[::1]", "printer.local"]) assert.equal(isPrivateHost(host), true, host);
	assert.match(validateEndpoint("http://example.com/hook"), /HTTPS/);
	assert.match(validateEndpoint("https://user:pass@example.com/hook"), /usuario ou senha/);
	assert.match(validateEndpoint("https://169.254.169.254/latest/meta-data"), /interno/);
	assert.equal(validateEndpoint("https://hooks.example.com/plano"), null);
});

test("entrega recusa nome que resolve para IP interno (checado na conexao)", async () => {
	const result = await new Promise((resolve) => safeLookup("localhost", { all: true }, (error, addresses) => resolve({ error, addresses })));
	assert.equal(result.error?.code, "WEBHOOK_PRIVATE_ADDRESS");
});

test("webhook recusa destino interno e guarda o segredo cifrado", async () => {
	const admin = await h.createUser("admin");
	const body = { name: "ERP", secret: "segredo-de-assinatura-longo", events: ["case.created"] };
	for (const endpointUrl of ["https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x", "https://169.254.169.254/x", "https://10.0.0.5/x"]) {
		const response = await h.api("POST", "/api/integrations/webhooks", { token: admin.token, body: { ...body, endpointUrl } });
		assert.equal(response.status, 400, endpointUrl);
	}
	assert.equal((await h.api("POST", "/api/integrations/webhooks", { token: admin.token, body: { ...body, secret: "curto", endpointUrl: "https://8.8.8.8/hook" } })).status, 400);
	const created = await h.api("POST", "/api/integrations/webhooks", { token: admin.token, body: { ...body, endpointUrl: "https://8.8.8.8/hook" } });
	assert.equal(created.status, 201);
	assert.equal(created.body.webhook.secret, undefined);
	const { rows } = await h.database.query("SELECT secret FROM webhooks WHERE id = $1", [created.body.webhook.id]);
	assert.match(rows[0].secret, /^enc:v1:/);
	assert.equal(decrypt(rows[0].secret), body.secret);
	await h.database.query("INSERT INTO webhooks (name, endpoint_url, secret, events) VALUES ('Antigo', 'https://8.8.4.4/x', 'segredo-em-texto-puro', '[\"case.created\"]')");
	assert.equal(await encryptLegacySecrets(), 1);
	assert.equal(await encryptLegacySecrets(), 0, "idempotente");
	const legacy = await h.database.query("SELECT secret FROM webhooks WHERE name = 'Antigo'");
	assert.equal(decrypt(legacy.rows[0].secret), "segredo-em-texto-puro");
	assert.notEqual(encrypt("a"), encrypt("a"), "IV aleatorio por valor");
});

// ------------------------------------------------------------------ P1: cabecalhos
test("cabecalhos de seguranca: CSP sem unsafe-inline, anti-frame, sem cache em /api", async () => {
	const page = await h.api("GET", "/");
	const csp = page.headers.get("content-security-policy");
	assert.match(csp, /default-src 'self'/);
	assert.match(csp, /style-src 'self'(;|$)/);
	assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
	assert.match(csp, /frame-ancestors 'none'/);
	assert.equal(page.headers.get("x-frame-options"), "DENY");
	assert.equal(page.headers.get("x-content-type-options"), "nosniff");
	assert.equal(page.headers.get("x-powered-by"), null);
	assert.equal(page.headers.get("strict-transport-security"), null, "HSTS so com HTTPS (COOKIE_SECURE)");
	assert.equal((await h.api("GET", "/api/meta")).headers.get("cache-control"), "no-store");
	const admin = await h.createUser("admin");
	const report = await h.api("GET", "/api/reports/export.html", { token: admin.token });
	assert.equal(report.status, 200);
	const reportCsp = report.headers.get("content-security-policy");
	assert.doesNotMatch(reportCsp, /unsafe-inline/);
	const nonce = reportCsp.match(/'nonce-([^']+)'/)[1];
	assert.ok(report.body.includes(`<script nonce="${nonce}">`));
	assert.doesNotMatch(report.body, /onclick=/);
});

// ------------------------------------------------------------------ P2: auditoria
test("auditoria geral registra login, falha e edicao de processo com IP; consulta por processo", async () => {
	const admin = await h.createUser("admin");
	await h.api("POST", "/api/auth/login", { body: { email: admin.email, password: "errada" } });
	await h.api("POST", "/api/auth/login", { headers: { "User-Agent": "Teste/1.0" }, body: { email: admin.email, password: h.PASSWORD } });
	const caseNumber = await h.createCase(admin.token);
	assert.equal((await h.api("PATCH", `/api/cases/${caseNumber}`, { token: admin.token, body: { client: "Cliente Renomeado" } })).status, 200);
	const audit = await h.api("GET", "/api/audit", { token: admin.token });
	assert.equal(audit.status, 200);
	const actions = audit.body.audit.map((entry) => entry.action);
	for (const action of ["LOGIN_FAILED", "LOGIN_SUCCESS", "CASE_EVENT"]) assert.ok(actions.includes(action), action);
	const success = audit.body.audit.find((entry) => entry.action === "LOGIN_SUCCESS");
	assert.ok(success.ip);
	assert.equal(success.userAgent, "Teste/1.0");
	const byCase = await h.api("GET", `/api/cases/${caseNumber}/audit`, { token: admin.token });
	assert.equal(byCase.status, 200);
	assert.ok(byCase.body.audit.some((entry) => entry.details.changes?.changes?.client?.after === "Cliente Renomeado"));
	const filtered = await h.api("GET", `/api/audit?caseNumber=${caseNumber}`, { token: admin.token });
	assert.ok(filtered.body.audit.length >= 2);
	assert.ok(filtered.body.audit.every((entry) => entry.caseNumber === caseNumber));
	const operator = await h.createUser("operator");
	assert.equal((await h.api("GET", "/api/audit", { token: operator.token })).status, 403);
	assert.equal((await h.api("GET", `/api/cases/${caseNumber}/audit`, { token: operator.token })).status, 403);
});

// ------------------------------------------------------------------ P2: sessoes
test("tela de sessoes: lista, encerra uma, encerra as outras e sair de todos", async () => {
	const operator = await h.createUser("operator");
	const first = await h.loginWithCookies(operator.email, h.PASSWORD, { "User-Agent": "Tablet" });
	const second = await h.loginWithCookies(operator.email, h.PASSWORD, { "User-Agent": "Desktop" });
	const listed = await h.api("GET", "/api/auth/sessions", { cookies: first.cookies });
	assert.equal(listed.body.sessions.length, 3, "duas por cookie + a do helper");
	assert.equal(listed.body.sessions.filter((session) => session.current).length, 1);
	const secondId = listed.body.sessions.find((session) => session.userAgent === "Desktop").id;
	assert.equal((await h.api("DELETE", `/api/auth/sessions/${secondId}`, { cookies: first.cookies })).status, 204);
	assert.equal((await h.api("GET", "/api/auth/me", { cookies: second.cookies })).status, 401);
	const others = await h.api("POST", "/api/auth/sessions/revoke-others", { cookies: first.cookies });
	assert.equal(others.body.sessionsEnded, 1);
	assert.equal((await h.api("GET", "/api/auth/me", { token: operator.token })).status, 401);
	const other = await h.createUser("operator");
	const foreign = (await h.database.query("SELECT id FROM sessions WHERE user_id = $1", [other.id])).rows[0].id;
	assert.equal((await h.api("DELETE", `/api/auth/sessions/${foreign}`, { cookies: first.cookies })).status, 404, "nao encerra sessao de outra pessoa");
	assert.equal((await h.api("POST", "/api/auth/logout-all", { cookies: first.cookies })).status, 204);
	assert.equal((await h.api("GET", "/api/auth/me", { cookies: first.cookies })).status, 401);
});

test("sessao ociosa expira e a limpeza agendada remove sessoes vencidas", async () => {
	const operator = await h.createUser("operator");
	await h.database.query("UPDATE sessions SET last_seen_at = NOW() - INTERVAL '1 day' WHERE user_id = $1", [operator.id]);
	assert.equal((await h.api("GET", "/api/auth/me", { token: operator.token })).status, 401);
	const other = await h.createUser("operator");
	await h.database.query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1", [other.id]);
	await h.database.query("INSERT INTO user_activity_log (user_id, action, path, created_at) VALUES ($1, 'navigation', '/', NOW() - INTERVAL '400 days')", [other.id]);
	const removed = await runHousekeeping();
	assert.ok(removed.sessions >= 1);
	assert.equal(removed.activity, 1);
});

test("administrador encerra as sessoes de um usuario; gerente so do proprio time", async () => {
	const admin = await h.createUser("admin");
	const manager = await h.createUser("manager");
	const outsider = await h.createUser("operator");
	assert.equal((await h.api("POST", `/api/users/${outsider.id}/sessions/revoke`, { token: manager.token })).status, 403);
	const revoked = await h.api("POST", `/api/users/${outsider.id}/sessions/revoke`, { token: admin.token });
	assert.equal(revoked.body.sessionsEnded, 1);
	assert.equal((await h.api("GET", "/api/auth/me", { token: outsider.token })).status, 401);
});

// ------------------------------------------------------------------ P2: LGPD (monitoramento)
test("monitoramento de uso guarda so o caminho e pode ser desligado", async () => {
	const operator = await h.createUser("operator");
	assert.equal((await h.api("POST", "/api/activity", { token: operator.token, body: { action: "click", path: "/caso.html?id=GAR-2026-0001&cpf=123", label: "<b>João</b> 123.456.789-00" } })).status, 204);
	const { rows } = await h.database.query("SELECT path, label FROM user_activity_log");
	assert.equal(rows[0].path, "/caso.html");
	assert.doesNotMatch(rows[0].label, /[<>]/);
	await setSetting("activity_tracking", false);
	await h.api("POST", "/api/activity", { token: operator.token, body: { action: "navigation", path: "/" } });
	assert.equal((await h.database.query("SELECT COUNT(*)::int AS count FROM user_activity_log")).rows[0].count, 1);
});

// ------------------------------------------------------------------ P3: MFA (TOTP)
test("TOTP confere com o vetor do RFC 6238", () => {
	const secret = totp.base32Encode(Buffer.from("12345678901234567890"));
	assert.equal(totp.codeAt(secret, Math.floor(59 / 30)), "287082");
	assert.equal(totp.codeAt(secret, Math.floor(1111111109 / 30)), "081804");
	assert.equal(totp.verify(secret, "287082", { now: 59000 }), 1);
	assert.equal(totp.verify(secret, "287082", { now: 59000, lastUsedStep: 1 }), null, "mesmo codigo nao vale duas vezes");
	assert.equal(totp.verify(secret, "000000", { now: 59000 }), null);
});

async function enrollMfa(cookies) {
	assert.equal((await h.api("POST", "/api/auth/mfa/setup", { cookies, body: { password: "errada" } })).status, 400);
	const setup = await h.api("POST", "/api/auth/mfa/setup", { cookies, body: { password: h.PASSWORD } });
	assert.equal(setup.status, 200);
	assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//);
	assert.match(setup.body.qrDataUrl, /^data:image\/svg\+xml;base64,/);
	assert.equal((await h.api("POST", "/api/auth/mfa/enable", { cookies, body: { code: "000000" } })).status, 400);
	const enabled = await h.api("POST", "/api/auth/mfa/enable", { cookies, body: { code: totp.codeAt(setup.body.secret, totp.currentStep()) } });
	assert.equal(enabled.status, 200);
	assert.equal(enabled.body.recoveryCodes.length, 10);
	return { secret: setup.body.secret, recoveryCodes: enabled.body.recoveryCodes };
}

test("MFA: ativar, entrar com codigo, codigo de recuperacao de uso unico e sem reuso de codigo", async () => {
	const admin = await h.createUser("admin");
	const { cookies } = await h.loginWithCookies(admin.email);
	const { secret, recoveryCodes } = await enrollMfa(cookies);
	const { rows } = await h.database.query("SELECT mfa_secret FROM users WHERE id = $1", [admin.id]);
	assert.match(rows[0].mfa_secret, /^enc:v1:/, "semente cifrada no banco");
	assert.equal((await h.api("GET", "/api/auth/me", { token: admin.token })).status, 401, "ativar o MFA encerra as outras sessoes");

	const first = await h.api("POST", "/api/auth/login", { body: { email: admin.email, password: h.PASSWORD } });
	assert.equal(first.body.mfaRequired, true);
	assert.equal(h.readCookies(first).session, "", "sem sessao antes do segundo fator");
	const wrong = await h.api("POST", "/api/auth/mfa/verify", { body: { challenge: first.body.challenge, code: "000000" } });
	assert.equal(wrong.status, 401);
	// O codigo da ativacao ja foi usado: vale o do proximo passo de 30 s (dentro da tolerancia).
	const nextCode = totp.codeAt(secret, totp.currentStep() + 1);
	const ok = await h.api("POST", "/api/auth/mfa/verify", { body: { challenge: first.body.challenge, code: nextCode } });
	assert.equal(ok.status, 200);
	assert.ok(h.readCookies(ok).session);
	assert.equal((await h.api("POST", "/api/auth/mfa/verify", { body: { challenge: first.body.challenge, code: nextCode } })).status, 401, "desafio de uso unico");

	const second = await h.api("POST", "/api/auth/login", { body: { email: admin.email, password: h.PASSWORD } });
	assert.equal((await h.api("POST", "/api/auth/mfa/verify", { body: { challenge: second.body.challenge, code: nextCode } })).status, 401, "mesmo codigo nao vale duas vezes");
	assert.equal((await h.api("POST", "/api/auth/mfa/verify", { body: { challenge: second.body.challenge, recoveryCode: recoveryCodes[0].toUpperCase() } })).status, 200);
	const third = await h.api("POST", "/api/auth/login", { body: { email: admin.email, password: h.PASSWORD } });
	assert.equal((await h.api("POST", "/api/auth/mfa/verify", { body: { challenge: third.body.challenge, recoveryCode: recoveryCodes[0] } })).status, 401, "codigo de recuperacao e de uso unico");
	const status = await h.api("GET", "/api/auth/mfa", { cookies: h.readCookies(ok) });
	assert.equal(status.body.enabled, true);
	assert.equal(status.body.recoveryCodesRemaining, 9);
});

test("MFA: desafio expira apos 5 codigos errados e as falhas contam no bloqueio do e-mail", async () => {
	const admin = await h.createUser("admin");
	const { cookies } = await h.loginWithCookies(admin.email);
	await enrollMfa(cookies);
	const login = await h.api("POST", "/api/auth/login", { body: { email: admin.email, password: h.PASSWORD } });
	const statuses = [];
	for (let attempt = 0; attempt < 6; attempt += 1) statuses.push((await h.api("POST", "/api/auth/mfa/verify", { body: { challenge: login.body.challenge, code: "111111" } })).status);
	assert.deepEqual(statuses.slice(0, 4), [401, 401, 401, 401]);
	assert.equal(statuses[4], 429, "5a falha bloqueia o e-mail");
	assert.equal((await h.api("POST", "/api/auth/login", { body: { email: admin.email, password: h.PASSWORD } })).status, 429);
});

test("MFA obrigatorio para administrador e gerente: so acessa depois de ativar; administrador remove MFA de outro", async () => {
	const admin = await h.createUser("admin");
	const manager = await h.createUser("manager");
	const operator = await h.createUser("operator");
	await setSetting("mfa_required", true);
	const blocked = await h.api("GET", "/api/cases", { token: manager.token });
	assert.equal(blocked.body.code, "MFA_ENROLLMENT_REQUIRED");
	assert.equal((await h.api("GET", "/api/cases", { token: operator.token })).status, 200, "operador nao e afetado");
	const { response, cookies } = await h.loginWithCookies(manager.email);
	assert.equal(response.body.user.mfaEnrollmentRequired, true);
	await enrollMfa(cookies);
	assert.equal((await h.api("GET", "/api/cases", { cookies })).status, 200);
	assert.equal((await h.api("POST", "/api/auth/mfa/disable", { cookies, body: { password: h.PASSWORD, code: "123456" } })).body.code, "MFA_REQUIRED");
	// Administrador sem MFA ainda pode remover o MFA de outro? Nao: ele mesmo precisa ativar antes.
	assert.equal((await h.api("POST", `/api/users/${manager.id}/mfa/reset`, { token: admin.token })).body.code, "MFA_ENROLLMENT_REQUIRED");
	await setSetting("mfa_required", false);
	assert.equal((await h.api("POST", `/api/users/${manager.id}/mfa/reset`, { token: operator.token })).status, 403);
	assert.equal((await h.api("POST", `/api/users/${manager.id}/mfa/reset`, { token: admin.token })).status, 204);
	assert.equal((await h.api("GET", "/api/auth/me", { cookies })).status, 401, "remover o MFA encerra as sessoes");
	assert.equal((await h.api("POST", "/api/auth/login", { body: { email: manager.email, password: h.PASSWORD } })).body.mfaRequired, undefined);
});

test("MFA: desativar exige senha e codigo", async () => {
	const operator = await h.createUser("operator");
	const { cookies } = await h.loginWithCookies(operator.email);
	const { secret } = await enrollMfa(cookies);
	const next = totp.codeAt(secret, totp.currentStep() + 1);
	assert.equal((await h.api("POST", "/api/auth/mfa/disable", { cookies, body: { password: "errada", code: next } })).status, 400);
	assert.equal((await h.api("POST", "/api/auth/mfa/disable", { cookies, body: { password: h.PASSWORD, code: "000000" } })).status, 400);
	assert.equal((await h.api("POST", "/api/auth/mfa/disable", { cookies, body: { password: h.PASSWORD, code: next } })).status, 204);
	assert.equal((await h.api("GET", "/api/auth/mfa", { cookies })).body.enabled, false);
});
