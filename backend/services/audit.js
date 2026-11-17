// Auditoria geral (P2): quem fez o que, quando, de qual IP e navegador. O contexto da requisicao
// (IP, user agent, request id) fica disponivel em qualquer ponto do codigo via AsyncLocalStorage,
// entao servicos chamados a partir de uma rota registram o IP sem precisar recebe-lo por parametro.
const { AsyncLocalStorage } = require("node:async_hooks");
const { database } = require("../db");
const { clientIp } = require("../middleware/security");
const { logEvent } = require("../middleware/errors");

const storage = new AsyncLocalStorage();

function requestContext(request, response, next) {
	storage.run({ ip: clientIp(request), userAgent: String(request.get("user-agent") || "").slice(0, 300), requestId: request.id }, next);
}

const currentContext = () => storage.getStore() || {};

const AUDIT_ACTIONS = Object.freeze({
	LOGIN_SUCCESS: "Login realizado",
	LOGIN_FAILED: "Falha de login",
	LOGIN_LOCKED: "Login bloqueado por tentativas",
	LOGIN_UNLOCKED: "Login desbloqueado pelo administrador",
	LOGIN_MFA_PENDING: "Senha correta, aguardando código MFA",
	MFA_FAILED: "Código MFA inválido",
	LOGOUT: "Saída do sistema",
	LOGOUT_ALL: "Saída de todos os dispositivos",
	SESSION_REVOKED: "Sessão encerrada",
	SESSIONS_REVOKED_BY_ADMIN: "Sessões encerradas pelo administrador",
	PASSWORD_CHANGED: "Senha alterada",
	PASSWORD_RESET: "Senha provisória definida pelo administrador",
	PASSWORD_RESET_REQUESTED: "Link de redefinição de senha enviado por e-mail",
	PASSWORD_RESET_BY_LINK: "Senha redefinida pelo link do e-mail",
	INVITE_SENT: "Convite de primeiro acesso enviado",
	INVITE_ACCEPTED: "Convite aceito (senha criada)",
	MFA_ENABLED: "MFA ativado",
	MFA_DISABLED: "MFA desativado",
	MFA_RESET_BY_ADMIN: "MFA removido pelo administrador",
	MFA_RECOVERY_USED: "Código de recuperação do MFA usado",
	MFA_RECOVERY_REGENERATED: "Códigos de recuperação do MFA gerados",
	USER_CREATED: "Usuário criado",
	USER_UPDATED: "Usuário alterado",
	USER_ACTIVATED: "Usuário ativado",
	USER_DEACTIVATED: "Usuário bloqueado",
	TEAM_TRANSFERRED: "Usuário transferido de time",
	SETTING_CHANGED: "Configuração alterada",
	WEBHOOK_CREATED: "Webhook criado",
	WEBHOOK_UPDATED: "Webhook alterado",
	CASE_EVENT: "Evento de processo"
});

/**
 * Grava um registro de auditoria. Dentro de transacao passe `executor` (o client da transacao) para que o
 * registro seja desfeito junto em caso de erro. Fora de transacao, falhas de auditoria sao registradas no
 * log e nao derrubam a operacao principal.
 */
async function audit(action, { actorId = null, entityType = null, entityId = null, details = null, executor = null } = {}) {
	const context = currentContext();
	const values = [
		actorId,
		action,
		entityType,
		entityId === null || entityId === undefined ? null : String(entityId),
		context.ip || null,
		context.userAgent || null,
		context.requestId || null,
		details ? JSON.stringify(details) : null
	];
	const sql = "INSERT INTO audit_log (actor_id, action, entity_type, entity_id, ip, user_agent, request_id, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)";
	if (executor) return executor.query(sql, values);
	try {
		await database.query(sql, values);
	} catch (error) {
		logEvent("audit_write_error", { action, error: error.message });
	}
	return null;
}

module.exports = { requestContext, currentContext, audit, AUDIT_ACTIONS };
