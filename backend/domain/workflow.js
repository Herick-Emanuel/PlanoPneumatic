// Maquina de estados por tipo de processo (F2) e regras de encerramento.
const { capabilities, can } = require("./permissions");

const common = {
	Criado: ["Em analise", "Cancelado"],
	"Em analise": ["Aguardando documento", "Aprovado", "Cancelado"],
	"Aguardando documento": ["Em analise", "Cancelado"],
	Concluido: ["Encerrado"]
};

const transitions = Object.freeze({
	"Pedido de venda": {
		...common,
		Aprovado: ["Em faturamento", "Em analise", "Cancelado"],
		"Em faturamento": ["Concluido"]
	},
	"Base de troca": {
		...common,
		"Em analise": ["Aguardando documento", "Aprovado", "Improcedente", "Cancelado"],
		Aprovado: ["Processando", "Cancelado"],
		Improcedente: ["Encerrado"],
		Processando: ["Concluido", "Cancelado"]
	},
	Garantia: {
		...common,
		"Em analise": ["Aguardando documento", "Aprovado", "Improcedente", "Cancelado"],
		Aprovado: ["Processando", "Cancelado"],
		Improcedente: ["Encerrado"],
		Processando: ["Concluido", "Cancelado"]
	}
});

const FINAL_STATUSES = ["Encerrado", "Cancelado"];
const DECISION_STATUSES = ["Aprovado", "Improcedente", "Encerrado"];
const REASON_REQUIRED = ["Cancelado", "Improcedente"];
const CLOSING_STATUSES = ["Concluido", "Encerrado"];
const REOPEN_TARGET = "Em analise";

function nextStatuses(type, status) {
	return transitions[type]?.[status] || [];
}

function isTransitionValid(type, from, to) {
	return nextStatuses(type, from).includes(to);
}

// Transicoes que o usuario pode executar, ja filtradas por papel. Reabertura aparece como destino especial.
function allowedTransitions(user, item) {
	const result = nextStatuses(item.type, item.status).filter((status) => !DECISION_STATUSES.includes(status) || can(user, capabilities.DECIDE_CASE));
	if (FINAL_STATUSES.includes(item.status) && can(user, capabilities.REOPEN_CASE)) result.push(REOPEN_TARGET);
	return can(user, capabilities.EDIT_CASE) || can(user, capabilities.DECIDE_CASE) ? result : [];
}

/**
 * Valida a regra de negocio da transicao. Retorna uma lista de mensagens (vazia quando permitida).
 * `context` traz: checklist (itens), attachmentCount, requireDocuments, reason, decision, destination.
 */
function validateTransition(user, item, target, context) {
	const isReopen = FINAL_STATUSES.includes(item.status) && target === REOPEN_TARGET;
	if (isReopen) {
		if (!can(user, capabilities.REOPEN_CASE)) return { code: "FORBIDDEN", message: "Somente gerente ou administrador pode reabrir processos." };
		if (!String(context.reason || "").trim()) return { code: "REASON_REQUIRED", message: "Informe a justificativa da reabertura." };
		return null;
	}
	if (!isTransitionValid(item.type, item.status, target)) {
		return { code: "INVALID_TRANSITION", message: `Transição inválida: de "${item.status}" não é possível ir para "${target}" neste tipo de processo.` };
	}
	if (DECISION_STATUSES.includes(target) && !can(user, capabilities.DECIDE_CASE)) {
		return { code: "FORBIDDEN", message: "Somente gerente, técnico ou administrador pode registrar esta decisão." };
	}
	if (REASON_REQUIRED.includes(target) && !String(context.reason || "").trim()) {
		return { code: "REASON_REQUIRED", message: `Informe o motivo para marcar como ${target}.` };
	}
	if (item.type === "Garantia" && target === "Aprovado") {
		if (!String(item.technical_report || "").trim()) return { code: "REPORT_REQUIRED", message: "Registre o laudo técnico antes de aprovar a garantia." };
		if (!context.destination && !item.warranty_destination) return { code: "DESTINATION_REQUIRED", message: "Informe o destino da garantia (reposição, devolução, troca ou arquivo)." };
	}
	if (item.type === "Base de troca" && target === "Aprovado" && (!item.exchange_reason || !item.item_condition)) {
		return { code: "FIELDS_REQUIRED", message: "Informe o motivo da troca e a condição do item antes de aprovar." };
	}
	if (item.type === "Garantia" && target === "Improcedente" &&!String(item.technical_report || "").trim()) {
		return { code: "REPORT_REQUIRED", message: "Registre o laudo técnico antes de marcar a garantia como improcedente." };
	}
	if (CLOSING_STATUSES.includes(target)) {
		const pending = context.checklist.filter((entry) => !entry.completed);
		if (pending.length && item.status !== "Improcedente") return { code: "CHECKLIST_PENDING", message: `Conclua o checklist antes de encerrar (${pending.length} item(ns) pendente(s)).` };
		if (context.requireDocuments && context.attachmentCount < 1 && item.status !== "Improcedente") return { code: "DOCUMENT_REQUIRED", message: "Anexe ao menos um documento antes de concluir ou encerrar o processo." };
	}
	return null;
}

module.exports = { transitions, nextStatuses, isTransitionValid, allowedTransitions, validateTransition, FINAL_STATUSES, DECISION_STATUSES, REASON_REQUIRED, CLOSING_STATUSES, REOPEN_TARGET };
