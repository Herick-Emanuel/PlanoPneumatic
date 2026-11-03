const { z } = require("zod");
const { CASE_TYPES, STATUSES, ATTACHMENT_KINDS, EXCHANGE_REASONS, ITEM_CONDITIONS, RISK_LEVELS, LOGISTICS_STATUSES, WARRANTY_DESTINATIONS } = require("../domain/constants");
const { isValidDocument, onlyDigits } = require("./document");

// Texto opcional: vazio vira undefined; espacos nas pontas sao removidos.
const optionalText = (max) => z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.string().trim().max(max, `Maximo de ${max} caracteres.`).optional());
const requiredText = (label, max) => z.string({ error: `Informe ${label}.` }).trim().min(1, `Informe ${label}.`).max(max, `Maximo de ${max} caracteres.`);
const optionalEnum = (values, label) => z.preprocess((value) => (value === "" || value === null ? undefined : value), z.enum(values, { error: `${label} invalido.` }).optional());
const money = z.preprocess((value) => {
	if (value === "" || value === null || value === undefined) return undefined;
	if (typeof value === "string") return Number(value.includes(",") ? value.replace(/\./g, "").replace(",", ".") : value);
	return value;
}, z.number({ error: "Valor invalido." }).min(0, "O valor nao pode ser negativo.").max(99999999.99, "Valor acima do limite.").optional());
const optionalDate = z.preprocess((value) => (value === "" || value === null ? undefined : value), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data invalida (use AAAA-MM-DD).").optional());
const optionalDocument = z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.string().refine(isValidDocument, "CPF ou CNPJ invalido.").transform(onlyDigits).optional());

const itemSchema = z.object({
	productCode: requiredText("o codigo do produto", 80),
	description: requiredText("a descricao do produto", 180),
	quantity: z.coerce.number({ error: "Quantidade invalida." }).int("Quantidade invalida.").min(1, "Quantidade invalida.").max(1000000),
	unitPrice: money,
	serialNumber: optionalText(80),
	lotNumber: optionalText(80)
});

const baseFields = {
	client: requiredText("o cliente", 180),
	clientDocument: optionalDocument,
	product: requiredText("o produto", 180),
	productCode: requiredText("o codigo do produto", 80),
	quantity: z.coerce.number({ error: "Informe uma quantidade valida." }).int("Informe uma quantidade valida.").min(1, "Informe uma quantidade valida.").max(1000000),
	documentReference: optionalText(120),
	notes: optionalText(4000),
	customerId: z.coerce.number().int().positive().optional(),
	productId: z.coerce.number().int().positive().optional(),
	salesRepresentative: optionalText(120),
	unitPrice: money,
	paymentTerms: optionalText(120),
	salesChannel: optionalText(80),
	exchangeReason: optionalEnum(EXCHANGE_REASONS, "Motivo da troca"),
	itemCondition: optionalEnum(ITEM_CONDITIONS, "Condicao do item"),
	originOrder: optionalText(80),
	trackingCode: optionalText(80),
	receivedAt: optionalDate,
	defectDescription: optionalText(4000),
	riskLevel: optionalEnum(RISK_LEVELS, "Nivel de risco"),
	serialNumber: optionalText(80),
	lotNumber: optionalText(80),
	items: z.array(itemSchema).max(100, "Maximo de 100 itens por pedido.").optional(),
	intake: z.boolean().optional(),
	omieOrderNumber: optionalText(20)
};

function requireByType(data, context) {
	const missing = (path, message) => context.addIssue({ code: "custom", path: [path], message });
	// A triagem rapida (intake) so coleta os dados basicos; os campos da troca sao exigidos antes da aprovacao.
	if (data.type === "Base de troca" && !data.intake) {
		if (!data.exchangeReason) missing("exchangeReason", "Informe o motivo da troca.");
		if (!data.itemCondition) missing("itemCondition", "Informe a condicao do item.");
	}
}

const createCaseSchema = z.object({ type: z.enum(CASE_TYPES, { error: "Tipo de processo invalido." }), ...baseFields }).superRefine(requireByType);

// Na edicao todos os campos sao opcionais (so os enviados mudam); o tipo nao muda.
const updateCaseSchema = z.object({
	...baseFields,
	technicalReport: optionalText(8000),
	technicalOwnerId: z.coerce.number().int().positive().optional(),
	warrantyDestination: optionalEnum(Object.keys(WARRANTY_DESTINATIONS), "Destino"),
	logisticsStatus: optionalEnum(LOGISTICS_STATUSES, "Status de logistica")
}).partial();

const statusSchema = z.object({
	status: z.enum(STATUSES, { error: "Status invalido para o processo." }),
	reason: optionalText(2000),
	destination: optionalEnum(Object.keys(WARRANTY_DESTINATIONS), "Destino")
});

const listQuerySchema = z.object({
	process: z.string().trim().max(60).optional(),
	client: z.string().trim().max(180).optional(),
	product: z.string().trim().max(180).optional(),
	productCode: z.string().trim().max(80).optional(),
	document: z.string().trim().max(120).optional(),
	responsible: z.string().trim().max(120).optional(),
	serial: z.string().trim().max(80).optional(),
	assignedTo: z.coerce.number().int().positive().optional(),
	type: z.enum(CASE_TYPES).optional(),
	status: z.enum(STATUSES).optional(),
	from: optionalDate,
	to: optionalDate,
	updatedAt: optionalDate,
	mine: z.enum(["true", "false"]).optional(),
	archived: z.enum(["true", "false"]).optional(),
	overdue: z.enum(["true", "false"]).optional(),
	sort: z.enum(["case_number", "client", "type", "status", "updated_at", "created_at", "due_at"]).default("updated_at"),
	direction: z.enum(["asc", "desc"]).default("desc"),
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(200).default(25)
});

const attachmentMetaSchema = z.object({
	kind: z.enum(ATTACHMENT_KINDS, { error: "Tipo de anexo invalido." }).default("documento"),
	stage: optionalText(60)
});

module.exports = { createCaseSchema, updateCaseSchema, statusSchema, listQuerySchema, attachmentMetaSchema, itemSchema, optionalText, requiredText, optionalDocument, money, optionalDate };
