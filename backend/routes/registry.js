const express = require("express");
const { z } = require("zod");
const { database } = require("../db");
const { capabilities, can } = require("../domain/permissions");
const { requireAuth } = require("../middleware/auth");
const { badRequest, conflict, forbidden, notFound, wrap } = require("../middleware/errors");
const { optionalText, requiredText, optionalDocument, money } = require("../validators/cases");
const { likeTerm } = require("../services/caseFilters");
const omie = require("../services/omie");
const omieProducts = require("../services/omieProducts");

const router = express.Router();
router.use(["/customers", "/products", "/representatives"], requireAuth);

// Representante padrao do cliente (controle de carcacas): "" ou null tira o representante.
const representativeField = z.preprocess((value) => (value === "" || value === null ? null : value), z.coerce.number().int().positive().nullable().optional());
const customerSchema = z.object({
	name: requiredText("o nome do cliente", 180),
	document: optionalDocument,
	email: z.preprocess((value) => (value === "" ? undefined : value), z.string().trim().email("E-mail invalido.").max(180).optional()),
	phone: optionalText(40),
	representativeId: representativeField
});
const CUSTOMER_FIELDS = `id, name, document, email, phone, active, representative_id AS "representativeId",
	(SELECT r.name FROM representatives r WHERE r.id = customers.representative_id) AS "representativeName"`;
const CUSTOMER_COLUMNS = { name: "name", document: "document", email: "email", phone: "phone", active: "active", representativeId: "representative_id" };
const booleanField = z.preprocess(
	(value) => (value === "on" || value === "true" ? true : value === "false" || value === "" ? false : value),
	z.boolean().optional()
);
// Unidade e valor de referencia sao enviados ao Omie; o NCM e informado por quem aprova o envio.
const unitField = z.preprocess(
	(value) => (value === "" || value === null ? undefined : String(value).trim().toUpperCase()),
	z.enum(omieProducts.UNITS, { error: `Unidade invalida: use ${omieProducts.UNITS.join(", ")}.` }).optional()
);
const ncmField = z.preprocess(
	(value) => (value === "" || value === null || value === undefined ? undefined : omieProducts.normalizeNcm(value) || "invalido"),
	z
		.string()
		.regex(/^[0-9]{4}[.][0-9]{2}[.][0-9]{2}$/, "NCM invalido: informe 8 digitos (0000.00.00).")
		.optional()
);
const productSchema = z.object({
	code: requiredText("o codigo do produto", 80),
	description: requiredText("a descricao do produto", 180),
	unit: unitField,
	referencePrice: money,
	remanufactured: booleanField
});
const PRODUCT_FIELDS = `id, code, description, active, remanufactured, unit, ncm, reference_price AS "referencePrice", omie_code AS "omieCode", omie_status AS "omieStatus",
	omie_error AS "omieError", omie_attempts AS "omieAttempts", omie_next_attempt_at AS "omieNextAttemptAt", omie_sent_at AS "omieSentAt"`;
const PRODUCT_COLUMNS = {
	code: "code",
	description: "description",
	unit: "unit",
	ncm: "ncm",
	referencePrice: "reference_price",
	active: "active",
	remanufactured: "remanufactured"
};
const searchSchema = z.object({
	q: z.string().trim().max(120).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	includeInactive: z.enum(["true", "false"]).optional(),
	omie: z.enum(["pending_approval", "sending", "synced", "error", "none"]).optional(),
	page: z.coerce.number().int().min(1).default(1)
});

function requireRegistryWrite(request) {
	// Qualquer usuario que cria processos pode cadastrar cliente/produto durante a triagem.
	if (!can(request.user, capabilities.CREATE_CASE) && !can(request.user, capabilities.MANAGE_REGISTRY)) throw forbidden();
}
function requireRegistryManage(request) {
	if (!can(request.user, capabilities.MANAGE_REGISTRY)) throw forbidden("Somente gerente, supervisor ou administrador altera cadastros existentes.");
}

function duplicate(error, message) {
	if (error.code === "23505") throw conflict(message, "DUPLICATE");
	throw error;
}

router.get(
	"/customers",
	wrap(async (request, response) => {
		const { q, limit, includeInactive, page } = searchSchema.parse(request.query);
		const values = [];
		const clauses = [includeInactive === "true" ? "TRUE" : "active = TRUE"];
		if (q) {
			values.push(likeTerm(q));
			const digits = q.replace(/\D/g, "");
			if (digits) values.push(likeTerm(digits));
			clauses.push(digits ? "(name ILIKE $1 OR document LIKE $2)" : "name ILIKE $1");
		}
		const { rows } = await database.query(
			`SELECT ${CUSTOMER_FIELDS} FROM customers WHERE ${clauses.join(" AND ")} ORDER BY name LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
			values
		);
		return response.json({ customers: rows });
	})
);

router.post(
	"/customers",
	wrap(async (request, response) => {
		requireRegistryWrite(request);
		const data = customerSchema.parse(request.body);
		try {
			const { rows } = await database.query(
				`INSERT INTO customers (name, document, email, phone, representative_id) VALUES ($1, $2, $3, $4, $5) RETURNING ${CUSTOMER_FIELDS}`,
				[data.name, data.document ?? null, data.email ?? null, data.phone ?? null, data.representativeId ?? null]
			);
			return response.status(201).json({ customer: rows[0] });
		} catch (error) {
			return duplicate(error, "Ja existe um cliente com este CPF/CNPJ.");
		}
	})
);

router.patch(
	"/customers/:id",
	wrap(async (request, response) => {
		requireRegistryManage(request);
		const data = customerSchema.partial().extend({ active: z.boolean().optional() }).parse(request.body);
		const entries = Object.entries(data).filter(([key]) => key in request.body && CUSTOMER_COLUMNS[key]);
		if (!entries.length) return response.json({ customer: null });
		try {
			const { rows } = await database.query(
				`UPDATE customers SET ${entries.map(([key], index) => `${CUSTOMER_COLUMNS[key]} = $${index + 1}`).join(", ")}, updated_at = NOW() WHERE id = $${entries.length + 1} RETURNING ${CUSTOMER_FIELDS}`,
				[...entries.map(([, value]) => value ?? null), Number(request.params.id)]
			);
			if (!rows[0]) throw notFound("Cliente nao encontrado.");
			return response.json({ customer: rows[0] });
		} catch (error) {
			return duplicate(error, "Ja existe um cliente com este CPF/CNPJ.");
		}
	})
);

router.get(
	"/products",
	wrap(async (request, response) => {
		const { q, limit, includeInactive, page, omie: omieFilter } = searchSchema.parse(request.query);
		const values = [];
		const clauses = [includeInactive === "true" ? "TRUE" : "active = TRUE"];
		if (q) {
			values.push(likeTerm(q));
			clauses.push(`(code ILIKE $${values.length} OR description ILIKE $${values.length})`);
		}
		if (omieFilter === "none") clauses.push("omie_status IS NULL");
		else if (omieFilter) {
			values.push(omieFilter);
			clauses.push(`omie_status = $${values.length}`);
		}
		const { rows } = await database.query(
			`SELECT ${PRODUCT_FIELDS} FROM products WHERE ${clauses.join(" AND ")} ORDER BY code LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
			values
		);
		return response.json({ products: rows, omieConfigured: omie.isConfigured() });
	})
);

router.post(
	"/products",
	wrap(async (request, response) => {
		requireRegistryWrite(request);
		const data = productSchema.parse(request.body);
		// Com o Omie ligado, a peca nova entra na fila de aprovacao e precisa da unidade.
		const status = omieProducts.initialStatus();
		if (status && !data.unit) throw badRequest("Informe a unidade da peca (exigida pelo Omie).", "UNIT_REQUIRED");
		try {
			const { rows } = await database.query(
				`INSERT INTO products (code, description, unit, reference_price, omie_status, remanufactured) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PRODUCT_FIELDS}`,
				[data.code, data.description, data.unit || null, data.referencePrice ?? null, status, Boolean(data.remanufactured)]
			);
			return response.status(201).json({ product: rows[0] });
		} catch (error) {
			return duplicate(error, "Ja existe um produto com este codigo.");
		}
	})
);

router.patch(
	"/products/:id",
	wrap(async (request, response) => {
		requireRegistryManage(request);
		const data = productSchema.partial().extend({ active: z.boolean().optional(), ncm: ncmField }).parse(request.body);
		const entries = Object.entries(data).filter(([key]) => key in request.body && PRODUCT_COLUMNS[key]);
		if (!entries.length) return response.json({ product: null });
		try {
			const { rows } = await database.query(
				`UPDATE products SET ${entries.map(([key], index) => `${PRODUCT_COLUMNS[key]} = $${index + 1}`).join(", ")}, updated_at = NOW() WHERE id = $${entries.length + 1} RETURNING ${PRODUCT_FIELDS}`,
				[...entries.map(([, value]) => value), Number(request.params.id)]
			);
			if (!rows[0]) throw notFound("Produto nao encontrado.");
			return response.json({ product: rows[0] });
		} catch (error) {
			return duplicate(error, "Ja existe um produto com este codigo.");
		}
	})
);

// Representantes (controle de carcacas): saldo de carcacas por representante.
const representativeSchema = z.object({
	name: requiredText("o nome do representante", 120),
	code: optionalText(40),
	email: z.preprocess((value) => (value === "" ? undefined : value), z.string().trim().email("E-mail invalido.").max(180).optional()),
	phone: optionalText(40)
});
const REPRESENTATIVE_FIELDS = `id, name, code, email, phone, active, (SELECT COUNT(*)::int FROM customers c WHERE c.representative_id = representatives.id) AS "customerCount"`;
router.get(
	"/representatives",
	wrap(async (request, response) => {
		const { q, includeInactive } = searchSchema.parse(request.query);
		const values = [];
		const clauses = [includeInactive === "true" ? "TRUE" : "active = TRUE"];
		if (q) {
			values.push(likeTerm(q));
			clauses.push("(name ILIKE $1 OR code ILIKE $1)");
		}
		const { rows } = await database.query(`SELECT ${REPRESENTATIVE_FIELDS} FROM representatives WHERE ${clauses.join(" AND ")} ORDER BY name`, values);
		return response.json({ representatives: rows });
	})
);
router.post(
	"/representatives",
	wrap(async (request, response) => {
		requireRegistryManage(request);
		const data = representativeSchema.parse(request.body);
		try {
			const { rows } = await database.query(
				`INSERT INTO representatives (name, code, email, phone) VALUES ($1, $2, $3, $4) RETURNING ${REPRESENTATIVE_FIELDS}`,
				[data.name, data.code ?? null, data.email ?? null, data.phone ?? null]
			);
			return response.status(201).json({ representative: rows[0] });
		} catch (error) {
			return duplicate(error, "Ja existe um representante com este codigo.");
		}
	})
);
router.patch(
	"/representatives/:id",
	wrap(async (request, response) => {
		requireRegistryManage(request);
		const data = representativeSchema.partial().extend({ active: z.boolean().optional() }).parse(request.body);
		const allowed = ["name", "code", "email", "phone", "active"];
		const entries = Object.entries(data).filter(([key]) => key in request.body && allowed.includes(key));
		if (!entries.length) return response.json({ representative: null });
		try {
			const { rows } = await database.query(
				`UPDATE representatives SET ${entries.map(([key], index) => `${key} = $${index + 1}`).join(", ")}, updated_at = NOW() WHERE id = $${entries.length + 1} RETURNING ${REPRESENTATIVE_FIELDS}`,
				[...entries.map(([, value]) => value ?? null), Number(request.params.id)]
			);
			if (!rows[0]) throw notFound("Representante nao encontrado.");
			return response.json({ representative: rows[0] });
		} catch (error) {
			return duplicate(error, "Ja existe um representante com este codigo.");
		}
	})
);

module.exports = { router };
