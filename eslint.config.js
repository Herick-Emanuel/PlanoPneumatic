const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
	{ ignores: ["node_modules/**", "playwright-report/**", "test-results/**", "frontend/icons/**"] },
	js.configs.recommended,
	{
		files: ["backend/**/*.js", "scripts/**/*.js", "e2e/**/*.js", "playwright.config.js", "eslint.config.js"],
		languageOptions: { sourceType: "commonjs", ecmaVersion: 2023, globals: { ...globals.node, ...globals.browser } },
		rules: { "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }] }
	},
	{
		files: ["frontend/js/**/*.js"],
		languageOptions: { sourceType: "script", ecmaVersion: 2023, globals: { ...globals.browser } },
		rules: { "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }], "no-redeclare": "off" }
	},
	{
		files: ["frontend/sw.js"],
		languageOptions: { sourceType: "script", ecmaVersion: 2023, globals: { ...globals.serviceworker } }
	}
];
