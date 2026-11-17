const { test, expect } = require("@playwright/test");
const totp = require("../backend/security/totp");

const users = { admin: ["admin@e2e.local", "Painel-Central-E2E-Seguro-7"], operator: ["operador@e2e.local", "Bancada-Recepcao-E2E-Firme-4"] };

// Nenhuma tela pode violar a CSP (sem 'unsafe-inline' em scripts e estilos).
test.beforeEach(async ({ page }, testInfo) => {
	testInfo.cspViolations = [];
	page.on("console", (message) => { if (/Content Security Policy|Refused to (apply|execute|load)/i.test(message.text())) testInfo.cspViolations.push(message.text()); });
});
// eslint-disable-next-line no-empty-pattern -- o Playwright exige o primeiro argumento desestruturado
test.afterEach(async ({}, testInfo) => {
	expect(testInfo.cspViolations ?? [], "violacoes de CSP no console").toEqual([]);
});
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function login(page, role) {
	await page.goto("/");
	await page.waitForLoadState("networkidle");
	await fillLogin(page, ...users[role]);
	await expect(page.getByRole("heading", { name: "Dashboard operacional" })).toBeVisible();
}

async function fillLogin(page, email, password) {
	await page.locator("#login-form").getByLabel("E-mail").fill(email);
	await page.locator("#login-form").getByLabel("Senha", { exact: true }).fill(password);
	await page.getByRole("button", { name: /Entrar/ }).click();
}

async function createWarranty(page, client) {
	await page.goto("/garantia.html");
	await page.locator('input[name="client"]').fill(client);
	await page.locator('input[name="product"]').fill("Compressor E2E");
	await page.locator('input[name="productCode"]').fill("E2E-01");
	await page.locator('textarea[name="defectDescription"]').fill("Vazamento");
	await page.getByRole("button", { name: /Salvar garantia/ }).click();
	await expect(page).toHaveURL(/caso\.html\?id=GAR-/);
	return new URL(page.url()).searchParams.get("id");
}

const confirmDialog = (page) => page.getByRole("dialog").getByRole("button", { name: "Confirmar" }).click();

test("triagem a encerramento sem passos manuais no banco (garantia)", async ({ page }) => {
	await login(page, "admin");
	const caseId = await createWarranty(page, "Cliente Fluxo E2E");
	await expect(page.getByRole("heading", { name: caseId })).toBeVisible();

	await page.getByRole("button", { name: "Em análise", exact: true }).click();
	await confirmDialog(page);
	await expect(page.locator(".case-badges")).toContainText("Em análise");

	// Sem laudo a aprovacao e bloqueada e o motivo aparece em "O que falta".
	await expect(page.getByText("Registrar o laudo técnico.")).toBeVisible();
	await page.getByLabel("Laudo técnico").fill("Vedação rompida por defeito de fabricação.");
	await page.getByRole("button", { name: "Salvar laudo" }).click();
	await expect(page.getByText("Laudo salvo.")).toBeVisible();

	await page.getByRole("button", { name: "Aprovado", exact: true }).click();
	await page.getByRole("dialog").getByLabel(/Destino da garantia/).selectOption("reposicao");
	await confirmDialog(page);
	await expect(page.locator(".case-badges")).toContainText("Aprovado");

	await page.getByRole("button", { name: "Processando", exact: true }).click();
	await confirmDialog(page);
	await expect(page.locator(".case-badges")).toContainText("Processando");

	// Concluir exige checklist completo e documento anexado.
	await page.getByRole("button", { name: "Concluído", exact: true }).click();
	await confirmDialog(page);
	await expect(page.getByText(/Conclua o checklist/)).toBeVisible();
	for (const box of await page.locator("[data-checklist]").all()) await box.check();
	await page.getByRole("button", { name: "Concluído", exact: true }).click();
	await confirmDialog(page);
	await expect(page.getByText(/Anexe ao menos um documento/)).toBeVisible();

	await page.locator("#attachment-kind").selectOption("comprovante");
	await page.locator("#attachment-file").setInputFiles({ name: "comprovante.png", mimeType: "image/png", buffer: PNG });
	await expect(page.getByText("comprovante.png")).toBeVisible();

	await page.getByRole("button", { name: "Concluído", exact: true }).click();
	await confirmDialog(page);
	await expect(page.locator(".case-badges")).toContainText("Concluído");
	await page.getByRole("button", { name: "Encerrado", exact: true }).click();
	await confirmDialog(page);
	await expect(page.locator(".case-badges")).toContainText("Encerrado");
	await expect(page.getByRole("button", { name: "Reabrir processo" })).toBeVisible();
});

test("operador nao ve acoes de decisao e a triagem valida o documento", async ({ page }) => {
	await login(page, "operator");
	await page.goto("/triagem.html");
	await page.getByText("Garantia", { exact: true }).first().click();
	await page.getByRole("button", { name: /Continuar/ }).click();
	await page.getByLabel(/^Nome ou razão social/).fill("Cliente Triagem E2E");
	await page.getByLabel(/^CPF ou CNPJ/).fill("111.111.111-11");
	await page.getByLabel(/^Produto/).fill("Valvula");
	await page.getByLabel(/^Código/).fill("VL-1");
	await page.getByRole("button", { name: /Continuar/ }).click();
	await expect(page.getByText("CPF ou CNPJ inválido.")).toBeVisible();
	await page.getByLabel(/^CPF ou CNPJ/).fill("52998224725");
	await page.getByRole("button", { name: /Continuar/ }).click();
	await page.locator("#triage-submit").click();
	await expect(page).toHaveURL(/caso\.html\?id=GAR-/);
	await expect(page.getByRole("button", { name: "Aprovado", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Em análise", exact: true })).toBeVisible();
});

test("dados com script sao exibidos como texto e nunca executam", async ({ page }) => {
	await login(page, "admin");
	const payload = "<img src=x onerror=window.__xss=1><script>window.__xss=2</script>";
	const caseId = await createWarranty(page, payload);
	await expect(page.locator("main")).toContainText("<img src=x");
	expect(await page.evaluate(() => window.__xss)).toBeUndefined();
	await page.goto(`/historico.html?client=${encodeURIComponent("img src=x")}`);
	await expect(page.getByRole("link", { name: caseId })).toBeVisible();
	expect(await page.evaluate(() => window.__xss)).toBeUndefined();
	await page.goto("/");
	await expect(page.getByRole("link", { name: caseId }).first()).toBeVisible();
	expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test("busca global por Ctrl+K abre o processo", async ({ page }) => {
	await login(page, "admin");
	const caseId = await createWarranty(page, "Cliente Busca E2E");
	await page.goto("/historico.html");
	await page.keyboard.press("Control+k");
	await page.getByLabel("Termo de busca").fill("Busca E2E");
	await page.getByRole("option", { name: new RegExp(caseId) }).click();
	await expect(page).toHaveURL(new RegExp(`id=${caseId}`));
});

test("historico ordena e filtra", async ({ page }) => {
	await login(page, "admin");
	await page.goto("/historico.html");
	await expect(page.locator("#history-body tr").first()).toBeVisible();
	await page.locator('th[data-sort="client"] button').click();
	await expect(page.locator('th[data-sort="client"]')).toHaveAttribute("aria-sort", /ascending|descending/);
	await page.locator('input[name="client"]').fill("Fluxo E2E");
	await page.getByRole("button", { name: /Pesquisar/ }).click();
	await expect(page.locator("#result-count")).toContainText("resultado");
});

test("sessao fica em cookie HttpOnly: nenhum token visivel para o JavaScript", async ({ page }) => {
	await login(page, "operator");
	const exposed = await page.evaluate(() => ({ cookies: document.cookie, storage: JSON.stringify({ ...localStorage }) }));
	expect(exposed.cookies).not.toContain("pp_session");
	expect(exposed.storage).not.toMatch(/"token"/);
	const cookies = await page.context().cookies();
	const session = cookies.find((cookie) => cookie.name === "pp_session");
	expect(session.httpOnly).toBe(true);
	expect(session.sameSite).toBe("Strict");
	// Requisicao forjada sem o cabecalho CSRF e recusada mesmo com o cookie.
	const status = await page.evaluate(async () => (await fetch("/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status);
	expect(status).toBe(403);
	await page.getByRole("button", { name: /Sair/ }).first().click();
	await expect(page.getByRole("heading", { name: "Entrar no sistema" })).toBeVisible();
	expect((await page.context().cookies()).find((cookie) => cookie.name === "pp_session")).toBeUndefined();
});

test("usuario criado pelo administrador troca a senha provisoria no primeiro acesso", async ({ page, browser }) => {
	await login(page, "admin");
	await page.goto("/cadastros.html");
	const form = page.locator("#create-user-form");
	await form.getByLabel("Nome").fill("Pessoa Nova E2E");
	const email = `pessoa.nova.${Date.now()}@e2e.local`;
	await form.getByLabel("E-mail").fill(email);
	await form.getByLabel(/Senha inicial/).fill("Inicial-Provisoria-Laranja-3");
	await form.getByRole("button", { name: /Criar conta/ }).click();
	await expect(page.getByText(email)).toBeVisible();
	await expect(page.getByText("Troca de senha pendente").first()).toBeVisible();

	const context = await browser.newContext();
	const other = await context.newPage();
	await other.goto("/");
	await other.waitForLoadState("networkidle");
	await fillLogin(other, email, "Inicial-Provisoria-Laranja-3");
	await expect(other.getByRole("heading", { name: "Crie sua senha pessoal" })).toBeVisible();
	const change = other.locator("#change-password-form");
	await change.getByLabel(/Senha atual/).fill("Inicial-Provisoria-Laranja-3");
	await change.getByLabel("Nova senha", { exact: true }).fill("123456789012");
	await change.getByLabel("Confirme a nova senha").fill("123456789012");
	await change.getByRole("button", { name: /Salvar nova senha/ }).click();
	await expect(change.locator(".feedback")).toContainText(/sequencia|comum/i);
	await change.getByLabel("Nova senha", { exact: true }).fill("Freio-Disco-Traseiro-2031");
	await change.getByLabel("Confirme a nova senha").fill("Freio-Disco-Traseiro-2031");
	await change.getByRole("button", { name: /Salvar nova senha/ }).click();
	await expect(other.getByRole("heading", { name: "Dashboard operacional" })).toBeVisible();
	await context.close();
});

test("MFA: ativar em Minha conta e entrar com o codigo do aplicativo", async ({ page, browser }) => {
	await login(page, "admin");
	await page.goto("/conta.html");
	await page.getByRole("button", { name: "Ativar verificação em duas etapas" }).click();
	await page.locator("#mfa-panel").getByLabel("Senha").fill(users.admin[1]);
	await page.locator("#mfa-panel").getByRole("button", { name: "Continuar" }).click();
	await expect(page.locator(".mfa-qr")).toBeVisible();
	await page.getByText("Não consigo ler o QR Code").click();
	const secret = (await page.locator(".mfa-secret").textContent()).replace(/\s/g, "");
	await page.getByLabel("Código de verificação").fill(totp.codeAt(secret, totp.currentStep()));
	await page.getByRole("button", { name: "Ativar" }).click();
	await expect(page.locator(".recovery-codes li")).toHaveCount(10);
	const recovery = (await page.locator(".recovery-codes li").first().textContent()).trim();
	await page.getByRole("button", { name: "Já guardei os códigos" }).click();
	await expect(page.locator("#mfa-status")).toHaveText("Ativa");

	const context = await browser.newContext();
	const other = await context.newPage();
	await other.goto("/");
	await other.waitForLoadState("networkidle");
	await fillLogin(other, ...users.admin);
	await expect(other.getByRole("heading", { name: "Verificação em duas etapas" })).toBeVisible();
	await other.locator("#mfa-form").getByLabel("Código de verificação").fill("000000");
	await other.locator("#mfa-form").getByRole("button", { name: /Verificar/ }).click();
	await expect(other.locator("#mfa-form .feedback")).toContainText(/invalido/i);
	await other.locator("#mfa-form").getByLabel("Código de verificação").fill("");
	await other.getByText("Perdi o celular").click();
	await other.getByLabel("Código de recuperação").fill(recovery);
	await other.locator("#mfa-form").getByRole("button", { name: /Verificar/ }).click();
	await expect(other.getByRole("heading", { name: "Dashboard operacional" })).toBeVisible();
	await context.close();

	// Desativa pela tela (senha + codigo novo) para nao afetar os outros testes do administrador.
	await page.reload();
	await page.getByRole("button", { name: "Desativar" }).click();
	await page.getByRole("dialog").getByLabel("Senha").fill(users.admin[1]);
	await page.getByRole("dialog").getByLabel("Código atual do aplicativo").fill(totp.codeAt(secret, totp.currentStep() + 1));
	await page.getByRole("dialog").getByRole("button", { name: "Desativar" }).click();
	await expect(page.locator("#mfa-status")).toHaveText("Desativada");
});
