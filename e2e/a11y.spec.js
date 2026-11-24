// Acessibilidade automatica (WCAG 2.1 A/AA) com axe-core nas telas principais, em modo claro e escuro.
// Nao substitui o teste com leitor de tela feito por uma pessoa: cobre contraste, rotulos, papeis ARIA e estrutura.
const { test, expect } = require("@playwright/test");
const { default: AxeBuilder } = require("@axe-core/playwright");

const PAGES = [
	["/", "Dashboard operacional"],
	["/triagem.html", null],
	["/garantia.html", null],
	["/carcacas.html", null],
	["/historico.html", null],
	["/relatorios.html", null],
	["/relatorios-personalizados.html", null],
	["/guia.html", null],
	["/cadastro-base.html", null],
	["/importar.html", null],
	["/omie.html", null],
	["/cadastros.html", null],
	["/auditoria.html", null],
	["/integracoes.html", null],
	["/configuracoes.html", null],
	["/conta.html", null],
	["/notificacoes.html", null]
];

async function audit(page) {
	const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
	return results.violations.map(
		(violation) =>
			`${violation.id} (${violation.impact}): ${violation.help} -> ${violation.nodes
				.slice(0, 3)
				.map((node) => node.target.join(" "))
				.join(" | ")}`
	);
}

test("tela de login e recuperacao de senha sem violacoes", async ({ page }) => {
	await page.goto("/");
	await page.waitForLoadState("networkidle");
	expect(await audit(page)).toEqual([]);
	await page.getByRole("button", { name: "Esqueci minha senha" }).click();
	expect(await audit(page)).toEqual([]);
});

for (const scheme of ["light", "dark"]) {
	test(`telas internas sem violacoes WCAG (${scheme})`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.goto("/");
		await page.waitForLoadState("networkidle");
		const form = page.locator("#login-form");
		await form.getByLabel("E-mail").fill("admin@e2e.local");
		await form.getByLabel("Senha", { exact: true }).fill("Painel-Central-E2E-Seguro-7");
		await form.getByRole("button", { name: /Entrar/ }).click();
		await expect(page.getByRole("heading", { name: "Dashboard operacional" })).toBeVisible();
		const problems = [];
		for (const [path] of PAGES) {
			await page.goto(path);
			await page.waitForLoadState("networkidle");
			await page.waitForTimeout(300);
			for (const line of await audit(page)) problems.push(`${path} ${line}`);
		}
		expect(problems).toEqual([]);
	});
}
