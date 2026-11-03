// Fonte unica de tipos, status, rotulos e papeis. O frontend consome estes valores por GET /api/meta.
const CASE_TYPES = Object.freeze(["Pedido de venda", "Base de troca", "Garantia"]);
const CASE_PREFIX = Object.freeze({ "Pedido de venda": "PV", "Base de troca": "TRO", Garantia: "GAR" });

// Os codigos de status sao os valores gravados no banco (estaveis, sem acento); os rotulos sao exibidos nas telas.
const STATUS_LABELS = Object.freeze({
	Criado: "Criado",
	"Em analise": "Em análise",
	"Aguardando documento": "Aguardando documento",
	Aprovado: "Aprovado",
	Improcedente: "Improcedente",
	"Em faturamento": "Em faturamento",
	Processando: "Processando",
	Concluido: "Concluído",
	Encerrado: "Encerrado",
	Cancelado: "Cancelado"
});
const STATUSES = Object.freeze(Object.keys(STATUS_LABELS));
const FINISHED_STATUSES = Object.freeze(["Concluido", "Encerrado", "Cancelado"]);
const DONE_STATUSES = Object.freeze(["Aprovado", "Concluido", "Encerrado"]);
const PAUSING_STATUS = "Aguardando documento";

const roles = Object.freeze({
	ADMIN: "admin",
	MANAGER: "manager",
	SUPERVISOR: "supervisor",
	OPERATOR: "operator",
	TECHNICIAN: "technician",
	LOGISTICS: "logistics",
	AUDITOR: "auditor"
});
const ROLE_LABELS = Object.freeze({
	admin: "Administrador",
	manager: "Gerente",
	supervisor: "Supervisor",
	operator: "Operador",
	technician: "Técnico",
	logistics: "Logística",
	auditor: "Auditor"
});

const ATTACHMENT_KINDS = Object.freeze(["foto", "laudo", "comprovante", "documento"]);
const WARRANTY_DESTINATIONS = Object.freeze({ reposicao: "Reposição", devolucao: "Devolução", troca: "Troca", arquivo: "Arquivo" });
const LOGISTICS_STATUSES = Object.freeze(["Aguardando coleta", "Em transporte", "Recebido na fábrica", "Devolvido ao cliente"]);
const EXCHANGE_REASONS = Object.freeze(["Defeito de fabricação", "Erro de pedido", "Dano no transporte", "Divergência de entrega"]);
const ITEM_CONDITIONS = Object.freeze(["Perfeito estado", "Dano leve", "Dano moderado", "Dano grave"]);
const RISK_LEVELS = Object.freeze(["Normal", "Atenção", "Alto"]);

const CHECKLIST_TEMPLATES = Object.freeze({
	"Pedido de venda": ["Validar dados comerciais", "Confirmar disponibilidade do produto", "Encaminhar para faturamento"],
	"Base de troca": ["Conferir documento de origem", "Avaliar condicao do produto", "Registrar aprovacao da troca"],
	Garantia: ["Conferir documento de compra", "Registrar analise tecnica", "Definir parecer da garantia"]
});

module.exports = {
	CASE_TYPES, CASE_PREFIX, STATUS_LABELS, STATUSES, FINISHED_STATUSES, DONE_STATUSES, PAUSING_STATUS,
	roles, ROLE_LABELS, ATTACHMENT_KINDS, WARRANTY_DESTINATIONS, LOGISTICS_STATUSES, EXCHANGE_REASONS,
	ITEM_CONDITIONS, RISK_LEVELS, CHECKLIST_TEMPLATES
};
