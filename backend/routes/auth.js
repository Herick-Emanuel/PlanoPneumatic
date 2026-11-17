const crypto = require("node:crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { database } = require("../db");
const { permissionMatrix } = require("../domain/permissions");
const { rateLimit } = require("../middleware/security");
const { requireAuth, createSession, hashToken, bearerToken } = require("../middleware/auth");
const { logEvent, badRequest, wrap } = require("../middleware/errors");
const mailer = require("../services/mailer");

const router = express.Router();

// Token de uso unico: "reset" vale 30 minutos; "invite" (primeiro acesso) vale 72 horas.
async function issueToken(userId, purpose) {
	const token = crypto.randomBytes(32).toString("hex");
	await database.query("DELETE FROM password_reset_tokens WHERE user_id = $1 OR expires_at <= NOW()", [userId]);
	await database.query(
		`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, purpose) VALUES ($1, $2, NOW() + INTERVAL '${purpose === "invite" ? "72 hours" : "30 minutes"}', $3)`,
		[userId, hashToken(token), purpose]
	);
	return token;
}

// Hash fixo usado para igualar o tempo de resposta quando o usuario nao existe (evita enumeracao por timing).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("invalid-placeholder-password", 12);

router.post(
	"/login",
	rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }),
	wrap(async (request, response) => {
		const email = String(request.body.email || "")
			.trim()
			.toLowerCase();
		const password = String(request.body.password || "");
		if (!email || !password) throw badRequest("Informe usuario e senha.");
		const { rows } = await database.query("SELECT id, name, email, password_hash, role FROM users WHERE email = $1 AND active = TRUE", [email]);
		const user = rows[0];
		if (!user) {
			await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
			return response.status(401).json({ message: "Usuario ou senha invalidos." });
		}
		if (!(await bcrypt.compare(password, user.password_hash))) return response.status(401).json({ message: "Usuario ou senha invalidos." });
		return response.json({ ...(await createSession(user.id)), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
	})
);

router.post(
	"/forgot-password",
	rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }),
	wrap(async (request, response) => {
		const email = String(request.body.email || "")
			.trim()
			.toLowerCase();
		if (email) {
			const { rows } = await database.query("SELECT id, name, email FROM users WHERE email = $1 AND active = TRUE", [email]);
			if (rows[0]) {
				const token = await issueToken(rows[0].id, "reset");
				if (process.env.NODE_ENV !== "production") logEvent("password_reset_token_dev", { userId: rows[0].id, token });
				await mailer
					.send({
						to: rows[0].email,
						subject: "PlanoPneumatic: redefinição de senha",
						title: "Redefina sua senha",
						lines: [
							`Olá, ${rows[0].name.split(" ")[0]}.`,
							"Recebemos um pedido para redefinir a sua senha. O link vale por 30 minutos e só pode ser usado uma vez.",
							"Se não foi você, ignore este e-mail: sua senha continua a mesma."
						],
						action: { label: "Definir nova senha", url: mailer.appUrl(`/?reset=${token}`) }
					})
					.catch((error) => logEvent("password_reset_mail_error", { error: error.message }));
			}
		}
		return response.json({ message: "Se o e-mail estiver cadastrado, enviaremos instrucoes para redefinir a senha." });
	})
);

router.post(
	"/reset-password",
	wrap(async (request, response) => {
		const token = String(request.body.token || "");
		const password = String(request.body.password || "");
		if (!token || password.length < 8) throw badRequest("Informe um token valido e uma senha com pelo menos 8 caracteres.");
		const { rows } = await database.query("SELECT user_id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()", [
			hashToken(token)
		]);
		if (!rows[0]) throw badRequest("Token invalido ou expirado.");
		await database.query("UPDATE users SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(password, 12), rows[0].user_id]);
		await database.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE token_hash = $1", [hashToken(token)]);
		await database.query("DELETE FROM sessions WHERE user_id = $1", [rows[0].user_id]);
		return response.json({ message: "Senha redefinida com sucesso." });
	})
);

router.post(
	"/logout",
	requireAuth,
	wrap(async (request, response) => {
		await database.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(bearerToken(request))]);
		return response.status(204).send();
	})
);

router.get("/me", requireAuth, (request, response) => response.json({ user: { ...request.user, capabilities: permissionMatrix[request.user.role] || [] } }));

// Informa se o token ainda vale (a tela usa para mostrar o formulario certo ou avisar que expirou).
router.get(
	"/token/:token",
	wrap(async (request, response) => {
		const { rows } = await database.query(
			"SELECT t.purpose, u.name, u.email FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW() AND u.active = TRUE",
			[hashToken(String(request.params.token))]
		);
		if (!rows[0]) return response.status(404).json({ message: "Este link expirou ou já foi usado. Peça um novo.", code: "TOKEN_INVALID" });
		return response.json({ purpose: rows[0].purpose, name: rows[0].name, email: rows[0].email });
	})
);

module.exports = { router, issueToken };
