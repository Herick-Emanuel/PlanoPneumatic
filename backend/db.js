const bcrypt = require("bcryptjs");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const MIGRATION_LOCK_ID = 727001;

const database = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/plano_pneumatic",
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
  statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 30000)
});

// Executa `work(client)` em uma unica transacao, com COMMIT/ROLLBACK no mesmo client do pool.
async function withTransaction(work) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function waitForDatabase(retries = 30) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await database.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Unico caminho de schema: arquivos em backend/migrations, aplicados em ordem, uma transacao por arquivo,
// protegidos por advisory lock para que dois processos subindo juntos nao colidam.
async function runMigrations() {
  const client = await database.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(120) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    const directory = path.join(__dirname, "migrations");
    const files = fs.readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
    const applied = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
    for (const file of files) {
      if (applied.has(file)) continue;
      try {
        await client.query("BEGIN");
        await client.query(fs.readFileSync(path.join(directory, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        error.message = `Migration ${file} falhou: ${error.message}`;
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

// Usuarios criados a partir de variaveis de ambiente (seed) precisam trocar a senha no primeiro login:
// a senha inicial ficou em arquivo/painel de deploy (SEED_FORCE_PASSWORD_CHANGE=false desliga, ex.: E2E).
async function createUserIfMissing(client, { name, email, password, role, mustChangePassword = false }) {
  await client.query(
    "INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING",
    [name, email, await bcrypt.hash(password, 12), role, mustChangePassword]
  );
}

const seedMustChange = () => !["false", "0", "no"].includes(String(process.env.SEED_FORCE_PASSWORD_CHANGE || "").toLowerCase());

// Desenvolvimento/teste: usuarios de demonstracao e alguns casos de exemplo.
async function seedDevelopment() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  const { passwordProblem } = require("./security/passwords");
  const { rows: existing } = await database.query("SELECT COUNT(*)::int AS count FROM users");
  if (!adminEmail || !adminPassword) {
    // Banco ja tem usuarios: as variaveis de seed podem ter sido removidas (recomendado depois da primeira subida).
    if (existing[0].count > 0) return;
    throw new Error("SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD sao obrigatorios na primeira subida.");
  }
  const seeds = [{ name: process.env.SEED_ADMIN_NAME || "Administrador", email: adminEmail.toLowerCase(), password: adminPassword, role: "admin", variable: "SEED_ADMIN_PASSWORD" }];
  if (process.env.SEED_OPERATOR_EMAIL && process.env.SEED_OPERATOR_PASSWORD) {
    seeds.push({ name: process.env.SEED_OPERATOR_NAME || "Operador de Triagem", email: process.env.SEED_OPERATOR_EMAIL.toLowerCase(), password: process.env.SEED_OPERATOR_PASSWORD, role: "operator", variable: "SEED_OPERATOR_PASSWORD" });
  }
  await withTransaction(async (client) => {
    for (const seed of seeds) {
      const { rows: found } = await client.query("SELECT 1 FROM users WHERE email = $1", [seed.email]);
      if (found[0]) continue;
      // P0: recusa criar usuario com senha de seed fraca ou igual aos exemplos do repositorio.
      const problem = passwordProblem(seed.password, seed);
      if (problem) throw new Error(`${seed.variable} recusada: ${problem} Defina uma senha forte antes de subir a aplicacao.`);
      await createUserIfMissing(client, { ...seed, mustChangePassword: seedMustChange() });
    }
    const { rows: users } = await client.query("SELECT id FROM users WHERE email = $1", [adminEmail.toLowerCase()]);
    if (!users[0]) return;
    const { rows: counts } = await client.query("SELECT COUNT(*)::int AS count FROM cases");
    if (counts[0].count > 0) return;
    const sample = [
      ["GAR-2026-0045", "Auto Viacao ABC Ltda.", "Garantia", "Em analise", "Renato"],
      ["TRO-2026-0018", "Transportes Horizonte", "Base de troca", "Aguardando documento", "Leonardo"],
      ["PV-2026-0187", "Oficina Central", "Pedido de venda", "Aprovado", "Mariana"]
    ];
    for (const [number, clientName, type, status, responsible] of sample) {
      await client.query(
        "INSERT INTO cases (case_number, client, type, status, responsible, created_by, assigned_to, due_at) VALUES ($1, $2, $3, $4, $5, $6, $6, NOW() + INTERVAL '3 days')",
        [number, clientName, type, status, responsible, users[0].id]
      );
    }
    for (const [prefix, year, last] of [["GAR", 2026, 45], ["TRO", 2026, 18], ["PV", 2026, 187]]) {
      await client.query("INSERT INTO case_sequences (prefix, year, last_value) VALUES ($1, $2, $3) ON CONFLICT (prefix, year) DO UPDATE SET last_value = GREATEST(case_sequences.last_value, EXCLUDED.last_value)", [prefix, year, last]);
    }
    await client.query("INSERT INTO case_events (case_id, event_type, description, responsible, actor_id) SELECT id, 'ABERTURA', 'Caso de exemplo (ambiente de desenvolvimento)', responsible, created_by FROM cases WHERE NOT EXISTS (SELECT 1 FROM case_events WHERE case_events.case_id = cases.id)");
  });
}

// Producao: nenhum dado de demonstracao. O primeiro administrador so e criado se ainda nao houver usuarios
// e as variaveis SEED_ADMIN_* existirem; alternativamente use `npm run create-admin`.
async function seedProduction() {
  const { validateSeedPasswords } = require("./security/passwords");
  const { rows } = await database.query("SELECT COUNT(*)::int AS count FROM users");
  if (rows[0].count > 0) {
    if (process.env.SEED_ADMIN_PASSWORD || process.env.SEED_OPERATOR_PASSWORD) {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: "config_warning", warning: "SEED_*_PASSWORD continua definida no ambiente, mas nao e mais usada: remova a variavel." }));
    }
    return;
  }
  validateSeedPasswords(process.env);
  const { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password } = process.env;
  if (!email || !password) return;
  await withTransaction((client) => createUserIfMissing(client, { name: process.env.SEED_ADMIN_NAME || "Administrador", email: email.toLowerCase(), password, role: "admin", mustChangePassword: seedMustChange() }));
}

async function initializeDatabase() {
  // As senhas de seed sao validadas so quando vao ser usadas (usuario ainda nao existe): uma variavel
  // antiga esquecida no ambiente nao impede a subida, apenas gera aviso em producao.
  await waitForDatabase();
  await runMigrations();
  if (process.env.NODE_ENV === "production") await seedProduction();
  else await seedDevelopment();
}

module.exports = { database, initializeDatabase, runMigrations, withTransaction, waitForDatabase, createUserIfMissing };

if (require.main === module) initializeDatabase().then(() => database.end()).catch(async (error) => { console.error(error); await database.end(); process.exitCode = 1; });
