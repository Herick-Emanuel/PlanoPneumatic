// Cria (ou confirma) o primeiro administrador: npm run create-admin -- email@empresa.com "Nome Completo"
// A senha vem da variavel ADMIN_PASSWORD para nao ficar no historico do shell.
const { database, runMigrations, waitForDatabase, createUserIfMissing } = require("../db");

async function main() {
	const [email, name = "Administrador"] = process.argv.slice(2);
	const password = process.env.ADMIN_PASSWORD;
	if (!email || !password) throw new Error("Uso: ADMIN_PASSWORD=... npm run create-admin -- email [nome]");
	if (password.length < 8) throw new Error("A senha deve ter ao menos 8 caracteres.");
	await waitForDatabase();
	await runMigrations();
	await createUserIfMissing(database, { name, email: email.toLowerCase(), password, role: "admin" });
	console.log(`Administrador ${email} pronto.`);
}

main().then(() => database.end()).catch(async (error) => { console.error(error.message); await database.end(); process.exitCode = 1; });
