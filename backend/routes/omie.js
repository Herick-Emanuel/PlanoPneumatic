const express = require("express");
const { z } = require("zod");
const { capabilities } = require("../domain/permissions");
const { requireAuth, requireCapability } = require("../middleware/auth");
const { wrap } = require("../middleware/errors");
const omie = require("../services/omie");

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

router.get("/orders/:number", requireCapability(capabilities.CREATE_CASE), wrap(async (request, response) => response.json({ order: await omie.lookupOrder(request.params.number) })));
router.get("/invoices/:number", requireCapability(capabilities.CREATE_CASE), wrap(async (request, response) => response.json({ invoice: await omie.lookupInvoice(request.params.number) })));

module.exports = { router };
