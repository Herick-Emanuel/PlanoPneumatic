const express = require("express");
const { z } = require("zod");
const { capabilities } = require("../domain/permissions");
const { requireAuth, requireCapability } = require("../middleware/auth");
const { wrap } = require("../middleware/errors");
const omie = require("../services/omie");
const omieImport = require("../services/omieImport");

const router = express.Router();
router.use(requireAuth);

router.get("/status", wrap(async (request, response) => response.json({ configured: omie.isConfigured() })));
router.get("/sync", requireCapability(capabilities.MANAGE_REGISTRY), wrap(async (request, response) => response.json(await omie.status())));

router.post("/sync", requireCapability(capabilities.MANAGE_REGISTRY), wrap(async (request, response) => {
	const { kind } = z.object({ kind: z.enum(["customers", "products", "all"]).default("all") }).parse(request.body || {});
	const kinds = kind === "all" ? ["customers", "products"] : [kind];
	const results = [];
	for (const item of kinds) results.push(await omie.runSync(item, { userId: request.user.id }));
	return response.json({ results });
}));

// F14: listas para escolher o que vira processo (abrem nos registros mais recentes).
const listQuery = z.object({
	from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	page: z.coerce.number().int().min(1).optional(),
	type: z.enum(["entrada", "saida", "todas"]).optional()
});
router.get("/orders", requireCapability(capabilities.IMPORT_CASES), wrap(async (request, response) => response.json(await omieImport.listOrders(listQuery.parse(request.query)))));
router.get("/invoices", requireCapability(capabilities.IMPORT_CASES), wrap(async (request, response) => response.json(await omieImport.listInvoices(listQuery.parse(request.query)))));
router.post("/import", requireCapability(capabilities.IMPORT_CASES), wrap(async (request, response) => {
	const data = z.object({
		kind: z.enum(["orders", "invoices"]),
		type: z.enum(["Pedido de venda", "Base de troca", "Garantia"]),
		refs: z.array(z.string().trim().min(1).max(30)).min(1).max(20)
	}).parse(request.body);
	return response.json(await omieImport.importRecords(request.user, data));
}));

router.get("/orders/:number", requireCapability(capabilities.CREATE_CASE), wrap(async (request, response) => response.json({ order: await omie.lookupOrder(request.params.number) })));
router.get("/invoices/:number", requireCapability(capabilities.CREATE_CASE), wrap(async (request, response) => response.json({ invoice: await omie.lookupInvoice(request.params.number) })));

module.exports = { router };
