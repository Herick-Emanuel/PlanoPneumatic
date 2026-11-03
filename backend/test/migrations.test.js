const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Client } = require("pg");

// Banco dedicado: precisa existir e ficar vazio entre execucoes (o teste recria o schema).
const url = process.env.MIGRATIONS_TEST_DATABASE_URL || (process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/plano_pneumatic_test").replace(/\/[^/]+$/, "/plano_pneumatic_migrations_test");

test("migrations run on an empty database, are idempotent and safe under concurrency", async () => {
	assert.match(new URL(url).pathname, /test/);
	const admin = new Client({ connectionString: url });
	await admin.connect();
	await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
	await admin.end();

	// Carrega o modulo apontando para o banco de migrations.
	process.env.DATABASE_URL = url;
	delete require.cache[require.resolve("../db")];
	const db = require("../db");
	try {
		await Promise.all([db.runMigrations(), db.runMigrations()]);
		await db.runMigrations();
		const { rows } = await db.database.query("SELECT version FROM schema_migrations ORDER BY version");
		assert.ok(rows.length >= 9);
		assert.equal(rows[0].version, "000_initial_schema.sql");
		const tables = (await db.database.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((row) => row.table_name);
		for (const table of ["cases", "case_sequences", "customers", "products", "case_items", "app_settings", "webhook_deliveries", "saved_filters"]) assert.ok(tables.includes(table), `falta a tabela ${table}`);
		const { rows: sla } = await db.database.query("SELECT COUNT(*)::int AS count FROM case_sla_config");
		assert.equal(sla[0].count, 3);
	} finally {
		await db.database.end();
		delete require.cache[require.resolve("../db")];
	}
});

test("a failing migration rolls back completely", async () => {
	const fs = require("node:fs");
	const path = require("node:path");
	const bad = path.join(__dirname, "..", "migrations", "999_broken.sql");
	fs.writeFileSync(bad, "CREATE TABLE should_not_exist (id INT); SELECT * FROM table_that_does_not_exist;");
	process.env.DATABASE_URL = url;
	delete require.cache[require.resolve("../db")];
	const db = require("../db");
	try {
		await assert.rejects(db.runMigrations(), /999_broken\.sql falhou/);
		const { rows } = await db.database.query("SELECT to_regclass('public.should_not_exist') AS name");
		assert.equal(rows[0].name, null);
	} finally {
		fs.unlinkSync(bad);
		await db.database.end();
		delete require.cache[require.resolve("../db")];
	}
});
