const { test, expect } = require("@playwright/test");

const users = { admin: ["admin@e2e.local", "E2eAdminPass1"], operator: ["operador@e2e.local", "E2eOperadorPass1"] };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function login(page, role) {
	await page.goto("/");
	await page.waitForLoadState("networkidle");
	await page.getByLabel("E-mail").fill(users[role][0]);
	await page.getByLabel("Senha").fill(users[role][1]);
	await page.getByRole("button", { name: /Entrar/ }).click();
	await expect(page.getByRole("heading", { name: "Dashboard operacional" })).toBeVisible();
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
