const { defineConfig } = require("@playwright/test");

const port = 4100;
const databaseUrl = process.env.E2E_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/plano_pneumatic_e2e";

module.exports = defineConfig({
	testDir: "./e2e",
	workers: 1,
	timeout: 60000,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
	use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure", locale: "pt-BR" },
	webServer: {
		command: "node backend/server.js",
		url: `http://localhost:${port}/health`,
		reuseExistingServer: !process.env.CI,
		env: {
			PORT: String(port),
			DATABASE_URL: databaseUrl,
			SEED_ADMIN_EMAIL: "admin@e2e.local",
			SEED_ADMIN_PASSWORD: "Painel-Central-E2E-Seguro-7",
			SEED_OPERATOR_EMAIL: "operador@e2e.local",
			SEED_OPERATOR_PASSWORD: "Bancada-Recepcao-E2E-Firme-4",
			// A troca obrigatoria no primeiro acesso tem teste proprio (usuario criado pelo administrador).
			SEED_FORCE_PASSWORD_CHANGE: "false",
			FRONTEND_ORIGIN: `http://localhost:${port}`,
			DISABLE_WEBHOOKS: "true"
		}
	}
});
