const express = require("express");
const { z } = require("zod");
const { database } = require("../db");
const { capabilities, can } = require("../domain/permissions");
const { requireAuth } = require("../middleware/auth");
const { conflict, forbidden, notFound, wrap } = require("../middleware/errors");
const { optionalText, requiredText, optionalDocument } = require("../validators/cases");
const { likeTerm } = require("../services/caseFilters");

const router = express.Router();
router.use(["/customers", "/products"], requireAuth);

const customerSchema = z.object({
	name: requiredText("o nome do cliente", 180),
	document: optionalDocument,
	email: z.preprocess((value) => (value === "" ? undefined : value), z.string().trim().email("E-mail invalido.").max(180).optional()),
	phone: optionalText(40)
});
const productSchema = z.object({ code: requiredText("o codigo do produto", 80), description: requiredText("a descricao do produto", 180) });
const searchSchema = z.object({ q: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(20), includeInactive: z.enum(["true", "false"]).optional(), page: z.coerce.number().int().min(1).default(1) });

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

router.get("/customers", wrap(async (request, response) => {
	const { q, limit, includeInactive, page } = searchSchema.parse(request.query);
	const values = [];
	const clauses = [includeInactive === "true" ? "TRUE" : "active = TRUE"];
	if (q) {
		values.push(likeTerm(q));
		const digits = q.replace(/\D/g, "");
		if (digits) values.push(likeTerm(digits));
		clauses.push(digits ? "(name ILIKE $1 OR document LIKE $2)" : "name ILIKE $1");
	}
	const { rows } = await database.query(`SELECT id, name, document, email, phone, active FROM customers WHERE ${clauses.join(" AND ")} ORDER BY name LIMIT ${limit} OFFSET ${(page - 1) * limit}`, values);
	return response.json({ customers: rows });
}));

router.post("/customers", wrap(async (request, response) => {
	requireRegistryWrite(request);
	const data = customerSchema.parse(request.body);
	try {
		const { rows } = await database.query("INSERT INTO customers (name, document, email, phone) VALUES ($1, $2, $3, $4) RETURNING id, name, document, email, phone, active", [data.name, data.document ?? null, data.email ?? null, data.phone ?? null]);
		return response.status(201).json({ customer: rows[0] });
	} catch (error) { return duplicate(error, "Ja existe um cliente com este CPF/CNPJ."); }
}));

router.patch("/customers/:id", wrap(async (request, response) => {
	requireRegistryManage(request);
	const data = customerSchema.partial().extend({ active: z.boolean().optional() }).parse(request.body);
	const entries = Object.entries({ name: data.name, document: data.document, email: data.email, phone: data.phone, active: data.active }).filter(([key]) => key in request.body);
	if (!entries.length) return response.json({ customer: null });
	try {
		const { rows } = await database.query(`UPDATE customers SET ${entries.map(([key], index) => `${key} = $${index + 1}`).join(", ")}, updated_at = NOW() WHERE id = $${entries.length + 1} RETURNING id, name, document, email, phone, active`, [...entries.map(([, value]) => value ?? null), Number(request.params.id)]);
		if (!rows[0]) throw notFound("Cliente nao encontrado.");
		return response.json({ customer: rows[0] });
	} catch (error) { return duplicate(error, "Ja existe um cliente com este CPF/CNPJ."); }
}));

router.get("/products", wrap(async (request, response) => {
	const { q, limit, includeInactive, page } = searchSchema.parse(request.query);
	const values = [];
	const clauses = [includeInactive === "true" ? "TRUE" : "active = TRUE"];
	if (q) { values.push(likeTerm(q)); clauses.push("(code ILIKE $1 OR description ILIKE $1)"); }
	const { rows } = await database.query(`SELECT id, code, description, active FROM products WHERE ${clauses.join(" AND ")} ORDER BY code LIMIT ${limit} OFFSET ${(page - 1) * limit}`, values);
	return response.json({ products: rows });
}));

router.post("/products", wrap(async (request, response) => {
	requireRegistryWrite(request);
	const data = productSchema.parse(request.body);
	try {
		const { rows } = await database.query("INSERT INTO products (code, description) VALUES ($1, $2) RETURNING id, code, description, active", [data.code, data.description]);
		return response.status(201).json({ product: rows[0] });
	} catch (error) { return duplicate(error, "Ja existe um produto com este codigo."); }
}));

router.patch("/products/:id", wrap(async (request, response) => {
	requireRegistryManage(request);
	const data = productSchema.partial().extend({ active: z.boolean().optional() }).parse(request.body);
	const entries = Object.entries(data).filter(([key]) => key in request.body);
	if (!entries.length) return response.json({ product: null });
	try {
		const { rows } = await database.query(`UPDATE products SET ${entries.map(([key], index) => `${key} = $${index + 1}`).join(", ")}, updated_at = NOW() WHERE id = $${entries.length + 1} RETURNING id, code, description, active`, [...entries.map(([, value]) => value), Number(request.params.id)]);
		if (!rows[0]) throw notFound("Produto nao encontrado.");
		return response.json({ product: rows[0] });
	} catch (error) { return duplicate(error, "Ja existe um produto com este codigo."); }
}));

module.exports = { router };
