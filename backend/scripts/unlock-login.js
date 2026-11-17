// Desbloqueia o login de um e-mail travado por tentativas (todos os IPs): npm run unlock-login -- email@empresa.com
const { database, waitForDatabase } = require("../db");
const { unlockEmail } = require("../services/loginThrottle");

async function main() {
	const [email] = process.argv.slice(2);
	if (!email) throw new Error("Uso: npm run unlock-login -- email@empresa.com");
	await waitForDatabase();
	const cleared = await unlockEmail(email);
	console.log(cleared ? `Login de ${email} desbloqueado (${cleared} contador(es) removido(s)).` : `Nenhum bloqueio encontrado para ${email}.`);
}

main().then(() => database.end()).catch(async (error) => { console.error(error.message); await database.end(); process.exitCode = 1; });
