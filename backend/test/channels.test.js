// E-mail, WhatsApp, convites, recuperacao de senha, agendamentos, antivirus, erros do navegador e periodo padrao.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { before, after, beforeEach, afterEach, test } = require("node:test");
const h = require("./helpers");
const mailer = require("../services/mailer");
const whatsapp = require("../services/whatsapp");
const notifications = require("../services/notifications");
const antivirus = require("../services/antivirus");
const reportSchedules = require("../services/reportSchedules");

const tokenFrom = (message, param) => new URL(message.text.match(/https?:\/\/\S+/)[0]).searchParams.get(param);

before(h.setup);
after(h.teardown);
beforeEach(h.resetDatabase);
afterEach(() => {
	for (const name of ["SMTP_HOST", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) delete process.env[name];
	antivirus.setScanner(null);
});

test("esqueci a senha: e-mail com link, token consultavel, troca unica e encerramento das sessoes", async () => {
	process.env.SMTP_HOST = "smtp.test.local";
	const operator = await h.createUser("operator");
	const answer = await h.api("POST", "/api/auth/forgot-password", { body: { email: operator.email } });
	assert.equal(answer.status, 200);
	assert.equal(mailer.outbox.length, 1);
	assert.equal(mailer.outbox[0].to, operator.email);
	const token = tokenFrom(mailer.outbox[0], "reset");
	assert.ok(token);

	const info = await h.api("GET", `/api/auth/token/${token}`);
	assert.equal(info.status, 200);
	assert.equal(info.body.purpose, "reset");
	assert.equal(info.body.email, operator.email);

	// O link segue a mesma politica de senha da seguranca (12+ caracteres, sem senhas comuns).
	const weak = await h.api("POST", "/api/auth/reset-password", { body: { token, password: "12345678" } });
	assert.equal(weak.status, 400);
	assert.equal(weak.body.code, "WEAK_PASSWORD");
	assert.equal((await h.api("POST", "/api/auth/reset-password", { body: { token, password: "Roda-Firme-na-Serra-42" } })).status, 200);
	const { rows: audited } = await h.database.query("SELECT action FROM audit_log WHERE action LIKE 'PASSWORD_RESET%' ORDER BY id");
	assert.deepEqual(
		audited.map((row) => row.action),
		["PASSWORD_RESET_REQUESTED", "PASSWORD_RESET_BY_LINK"]
	);
	assert.equal((await h.api("GET", "/api/auth/me", { token: operator.token })).status, 401, "sessoes antigas encerradas");
	assert.equal((await h.api("GET", `/api/auth/token/${token}`)).status, 404, "token usado nao vale de novo");
	assert.equal((await h.api("POST", "/api/auth/login", { body: { email: operator.email, password: "Roda-Firme-na-Serra-42" } })).status, 200);

	// E-mail desconhecido responde igual e nao envia nada.
	mailer.outbox.length = 0;
	assert.equal((await h.api("POST", "/api/auth/forgot-password", { body: { email: "ninguem@test.local" } })).status, 200);
	assert.equal(mailer.outbox.length, 0);

	// Sem SMTP configurado nenhum link e gerado (so o administrador redefine).
	delete process.env.SMTP_HOST;
	await h.database.query("DELETE FROM password_reset_tokens");
	assert.equal((await h.api("POST", "/api/auth/forgot-password", { body: { email: operator.email } })).status, 200);
	assert.equal((await h.database.query("SELECT COUNT(*)::int AS n FROM password_reset_tokens")).rows[0].n, 0);
});

test("convite: conta criada sem senha, link de primeiro acesso (72 h) e reenvio pelo gerente do time", async () => {
	const admin = await h.createUser("admin");
	const created = await h.api("POST", "/api/users", {
		token: admin.token,
		body: { name: "Nova Pessoa", email: "nova@test.local", role: "operator", invite: true }
	});
	assert.equal(created.status, 201);
	assert.equal(created.body.invited, true);
	assert.equal(mailer.outbox.length, 1);
	const token = tokenFrom(mailer.outbox[0], "convite");
	const info = await h.api("GET", `/api/auth/token/${token}`);
	assert.equal(info.body.purpose, "invite");
	const { rows } = await h.database.query("SELECT expires_at > NOW() + INTERVAL '71 hours' AS long FROM password_reset_tokens WHERE purpose = 'invite'");
	assert.equal(rows[0].long, true);
	assert.equal((await h.api("POST", "/api/auth/reset-password", { body: { token, password: "Valvula-Azul-no-Patio-18" } })).status, 200);
	assert.equal((await h.api("POST", "/api/auth/login", { body: { email: "nova@test.local", password: "Valvula-Azul-no-Patio-18" } })).status, 200);

	// Sem convite, a senha inicial continua obrigatoria.
	assert.equal(
		(await h.api("POST", "/api/users", { token: admin.token, body: { name: "Sem Senha", email: "semsenha@test.local", role: "operator" } })).status,
		400
	);

	const manager = await h.createUser("manager");
	const own = await h.createUser("operator", { managerId: manager.id });
	const other = await h.createUser("operator");
	mailer.outbox.length = 0;
	assert.equal((await h.api("POST", `/api/users/${own.id}/invite`, { token: manager.token })).status, 200);
	assert.equal(mailer.outbox.length, 1);
	assert.equal((await h.api("POST", `/api/users/${other.id}/invite`, { token: manager.token })).status, 403);
	const audit = await h.database.query("SELECT 1 FROM user_audit_log WHERE action = 'INVITE_SENT'");
	assert.ok(audit.rows.length >= 1);
});

test("minha conta: celular validado e canais de aviso escolhidos pela pessoa", async () => {
	const operator = await h.createUser("operator");
	const bad = await h.api("PATCH", "/api/account", { token: operator.token, body: { name: operator.name, phone: "123" } });
	assert.equal(bad.status, 400);
	const ok = await h.api("PATCH", "/api/account", {
		token: operator.token,
		body: { name: operator.name, phone: "(19) 99876-5432", notifyEmail: false, notifyWhatsapp: true }
	});
	assert.equal(ok.status, 200);
	assert.equal(ok.body.user.phone, "19998765432");
	assert.equal(ok.body.user.notifyEmail, false);
	assert.equal(ok.body.user.notifyWhatsapp, true);
	const account = await h.api("GET", "/api/account", { token: operator.token });
	assert.deepEqual(account.body.channels, { email: false, whatsapp: false });
});

test("avisos saem por e-mail e WhatsApp conforme a preferencia, e cada envio fica registrado", async () => {
	process.env.SMTP_HOST = "smtp.test.local";
	process.env.WHATSAPP_TOKEN = "token";
	process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
	const sent = [];
	whatsapp.setTransport(async (url, options) => {
		sent.push({ url, body: JSON.parse(options.body) });
		return { ok: true, status: 200, json: async () => ({}) };
	});
	const both = await h.createUser("operator");
	const emailOnly = await h.createUser("operator");
	await h.database.query("UPDATE users SET phone = '19998765432', notify_whatsapp = TRUE WHERE id = $1", [both.id]);
	const caseNumber = await h.createCase(both.token);
	const { rows } = await h.database.query("SELECT id FROM cases WHERE case_number = $1", [caseNumber]);

	await notifications.notifyUser(both.id, rows[0].id, "CASE_ASSIGNED", `O processo ${caseNumber} foi atribuido a voce.`);
	await notifications.notifyUser(emailOnly.id, rows[0].id, "CASE_ASSIGNED", "Outro aviso.");
	await notifications.idle();

	assert.equal(mailer.outbox.filter((message) => message.to === both.email).length, 1);
	assert.match(mailer.outbox.find((message) => message.to === both.email).text, /caso\.html\?id=/);
	assert.equal(sent.length, 1, "WhatsApp so para quem ligou o canal");
	assert.equal(sent[0].body.to, "5519998765432");
	const deliveries = await h.database.query("SELECT user_id, channel, status FROM notification_deliveries ORDER BY id");
	assert.deepEqual(deliveries.rows.map((row) => `${row.user_id === both.id ? "both" : "email"}:${row.channel}:${row.status}`).sort(), [
		"both:email:sent",
		"both:whatsapp:sent",
		"email:email:sent"
	]);
	whatsapp.setTransport((...args) => fetch(...args));
});

test("agendamentos: regra de horario, CRUD do proprio usuario e envio com anexo", async () => {
	const at = (iso) => new Date(iso);
	const weekly = { active: true, frequency: "weekly", weekday: 1, hour: 7, lastSentAt: null };
	assert.equal(reportSchedules.isDue(weekly, at("2026-11-16T10:30:00Z")), true, "segunda 7h30 em Sao Paulo");
	assert.equal(reportSchedules.isDue(weekly, at("2026-11-16T09:30:00Z")), false, "antes das 7h");
	assert.equal(reportSchedules.isDue(weekly, at("2026-11-17T10:30:00Z")), false, "terca");
	assert.equal(reportSchedules.isDue({ ...weekly, lastSentAt: "2026-11-16T10:31:00Z" }, at("2026-11-16T20:00:00Z")), false, "ja enviado hoje");
	assert.equal(reportSchedules.isDue({ active: true, frequency: "monthly", hour: 7 }, at("2026-12-01T11:00:00Z")), true);
	assert.equal(reportSchedules.isDue({ active: true, frequency: "monthly", hour: 7 }, at("2026-12-02T11:00:00Z")), false);

	const manager = await h.createUser("manager");
	await h.createCase(manager.token);
	const created = await h.api("POST", "/api/reports/schedules", {
		token: manager.token,
		body: { name: "Semanal", format: "xlsx", frequency: "weekly", weekday: 1, hour: 7 }
	});
	assert.equal(created.status, 201);
	assert.match(created.body.schedule.description, /semanal/);

	const failed = await h.api("POST", `/api/reports/schedules/${created.body.schedule.id}/send`, { token: manager.token });
	assert.equal(failed.status, 422, "sem SMTP o envio falha com mensagem clara");
	process.env.SMTP_HOST = "smtp.test.local";
	const sent = await h.api("POST", `/api/reports/schedules/${created.body.schedule.id}/send`, { token: manager.token });
	assert.equal(sent.status, 200);
	assert.equal(sent.body.rows, 1);
	const message = mailer.outbox.at(-1);
	assert.equal(message.to, manager.email);
	assert.match(message.attachments[0].filename, /\.xlsx$/);
	assert.ok(message.attachments[0].content.length > 100);

	const other = await h.createUser("manager");
	assert.equal(
		(await h.api("DELETE", `/api/reports/schedules/${created.body.schedule.id}`, { token: other.token })).status,
		404,
		"nao mexe no agendamento de outra pessoa"
	);
	assert.equal(
		(await h.api("PATCH", `/api/reports/schedules/${created.body.schedule.id}`, { token: manager.token, body: { active: false } })).body.schedule.active,
		false
	);
	assert.equal((await h.api("DELETE", `/api/reports/schedules/${created.body.schedule.id}`, { token: manager.token })).status, 204);
});

test("antivirus: arquivo infectado e recusado; limpo, indisponivel e sem antivirus ficam marcados", async () => {
	const operator = await h.createUser("operator");
	const caseNumber = await h.createCase(operator.token);
	const upload = () =>
		h.api("POST", `/api/cases/${caseNumber}/attachments/upload?kind=foto`, {
			token: operator.token,
			raw: h.PNG,
			headers: { "Content-Type": "application/octet-stream", "X-File-Name": "foto.png" }
		});

	assert.equal((await upload()).body.attachment.scanStatus, "skipped");
	antivirus.setScanner(async () => "stream: Eicar-Signature FOUND");
	const infected = await upload();
	assert.equal(infected.status, 422);
	assert.equal(infected.body.code, "FILE_INFECTED");
	antivirus.setScanner(async () => "stream: OK");
	assert.equal((await upload()).status, 201);
	antivirus.setScanner(async () => {
		throw new Error("connect ECONNREFUSED");
	});
	assert.equal((await upload()).status, 201, "antivirus fora do ar nao bloqueia o trabalho");
	const { rows } = await h.database.query("SELECT scan_status FROM case_attachments ORDER BY id");
	assert.deepEqual(
		rows.map((row) => row.scan_status),
		["skipped", "clean", "error"]
	);
	const listed = await h.api("GET", `/api/cases/${caseNumber}/attachments`, { token: operator.token });
	assert.ok(listed.body.attachments.every((item) => "scanStatus" in item));
});

test("erros do navegador exigem login e sao aceitos", async () => {
	const operator = await h.createUser("operator");
	assert.equal((await h.api("POST", "/api/client-errors", { body: { message: "x" } })).status, 401);
	assert.equal(
		(await h.api("POST", "/api/client-errors", { token: operator.token, body: { message: "TypeError: a is undefined", page: "/caso.html", line: 10 } })).status,
		204
	);
});

test("relatorios valem os ultimos 90 dias por padrao; period=all mostra tudo", async () => {
	const manager = await h.createUser("manager");
	const old = await h.createCase(manager.token);
	await h.createCase(manager.token);
	await h.database.query("UPDATE cases SET created_at = NOW() - INTERVAL '200 days', updated_at = NOW() - INTERVAL '200 days' WHERE case_number = $1", [old]);
	const recent = await h.api("GET", "/api/reports/summary", { token: manager.token });
	const all = await h.api("GET", "/api/reports/summary?period=all", { token: manager.token });
	assert.equal(Number(recent.body.totals.total), 1);
	assert.equal(Number(all.body.totals.total), 2);
});

test("producao exige FRONTEND_ORIGIN e API_PUBLIC_URL em https", () => {
	const run = (env) => {
		try {
			execFileSync(process.execPath, ["-e", "require('./backend/config').validateConfig()"], {
				cwd: path.join(__dirname, "..", ".."),
				env: {
					PATH: process.env.PATH,
					NODE_ENV: "production",
					DATABASE_URL: "postgres://x",
					APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
					...env
				},
				stdio: "pipe"
			});
			return "ok";
		} catch (error) {
			return String(error.stderr);
		}
	};
	assert.match(run({}), /FRONTEND_ORIGIN e API_PUBLIC_URL sao obrigatorias/);
	assert.match(run({ FRONTEND_ORIGIN: "http://app.test", API_PUBLIC_URL: "https://api.test" }), /URL https/);
	assert.equal(run({ FRONTEND_ORIGIN: "https://app.test", API_PUBLIC_URL: "https://api.test" }), "ok");
});
