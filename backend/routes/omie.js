const express = require("express");
const { z } = require("zod");
const { capabilities } = require("../domain/permissions");
const { requireAuth, requireCapability } = require("../middleware/auth");
const { wrap, notFound } = require("../middleware/errors");
const { rateLimit } = require("../middleware/security");
const { safeEqual } = require("../security/crypto");
const omie = require("../services/omie");
const omieImport = require("../services/omieImport");
const omieMirror = require("../services/omieMirror");
const omieWebhook = require("../services/omieWebhook");
const omieProducts = require("../services/omieProducts");

const router = express.Router();

// Webhook do Omie (sem sessao): autenticado pelo token secreto na URL e pela app_key do aviso.
// Responde na hora; o processamento acontece em seguida, em fila.
router.post(
	"/webhook/:token",
	rateLimit({ windowMs: 60000, max: 600, name: "omie-webhook" }),
	wrap(async (request, response) => {
		const expected = process.env.OMIE_WEBHOOK_TOKEN || "";
		if (!expected || !omie.isConfigured() || !safeEqual(String(request.params.token), expected)) throw notFound("Rota nao encontrada.");
		const body = request.body || {};
		if (body.appKey && String(body.appKey).trim() !== String(process.env.OMIE_APP_KEY || "").trim()) throw notFound("Rota nao encontrada.");
		const result = await omieWebhook.receive(body);
		return response.json({ ok: true, ...result });
	})
);

router.use(requireAuth);

router.get(
	"/status",
	wrap(async (request, response) => response.json({ configured: omie.isConfigured() }))
);
router.get(
	"/sync",
	requireCapability(capabilities.MANAGE_REGISTRY),
	wrap(async (request, response) => response.json(await omie.status()))
);

router.post(
	"/sync",
	requireCapability(capabilities.MANAGE_REGISTRY),
	wrap(async (request, response) => {
		const { kind } = z.object({ kind: z.enum(["customers", "products", "orders", "invoices", "all"]).default("all") }).parse(request.body || {});
		const kinds = kind === "all" ? ["customers", "products"] : [kind];
		const results = [];
		for (const item of kinds) results.push(await omie.runSync(item, { userId: request.user.id }));
		return response.json({ results });
	})
);

// Espelho de pedidos/notas: situacao (a tela consulta a cada 30 s para se atualizar sozinha) e
// "Atualizar agora" (busca no Omie so o que mudou desde a ultima sincronizacao).
router.get(
	"/mirror",
	requireCapability(capabilities.IMPORT_CASES),
	wrap(async (request, response) =>
		response.json({ configured: omie.isConfigured(), webhook: Boolean(process.env.OMIE_WEBHOOK_TOKEN), ...(await omieMirror.mirrorStatus()) })
	)
);
router.post(
	"/mirror/refresh",
	requireCapability(capabilities.IMPORT_CASES),
	wrap(async (request, response) => {
		const { kind } = z.object({ kind: z.enum(["orders", "invoices"]) }).parse(request.body || {});
		// Repetir a mesma busca em menos de 60 s faz o Omie bloquear: dentro desse intervalo ja esta atualizado.
		const last = await omie.lastSuccess(kind);
		if (last && Date.now() - new Date(last).getTime() < 60000)
			return response.json({ recent: true, message: "Já atualizado há instantes.", result: { created: 0, updated: 0 } });
		try {
			return response.json({ result: await omie.runSync(kind, { trigger: "manual", userId: request.user.id }) });
		} catch (error) {
			if (error.code === "SYNC_RUNNING") return response.status(202).json({ running: true, message: "Uma atualização já está em andamento." });
			throw error;
		}
	})
);

// Envio de pecas ao Omie: aprovar (individual ou em lote, com NCM) e reenviar.
const productIds = z.coerce.number().int().positive();
router.post(
	"/products/approve",
	requireCapability(capabilities.APPROVE_OMIE_PRODUCTS),
	wrap(async (request, response) => {
		const { items } = z
			.object({
				items: z
					.array(z.object({ id: productIds, ncm: z.string().trim().max(12), unit: z.string().trim().max(10).optional() }))
					.min(1)
					.max(100)
			})
			.parse(request.body);
		return response.json(await omieProducts.approve(request.user, items));
	})
);
router.post(
	"/products/:id/retry",
	requireCapability(capabilities.APPROVE_OMIE_PRODUCTS),
	wrap(async (request, response) => response.json(await omieProducts.retry(request.user, productIds.parse(request.params.id))))
);

// F14: listas para escolher o que vira processo (abrem nos registros mais recentes).
const listQuery = z.object({
	from: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	to: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	page: z.coerce.number().int().min(1).max(100000).optional(),
	type: z.enum(["entrada", "saida", "todas"]).optional()
});
router.get(
	"/orders",
	requireCapability(capabilities.IMPORT_CASES),
	wrap(async (request, response) => response.json(await omieImport.listOrders(listQuery.parse(request.query))))
);
router.get(
	"/invoices",
	requireCapability(capabilities.IMPORT_CASES),
	wrap(async (request, response) => response.json(await omieImport.listInvoices(listQuery.parse(request.query))))
);
router.post(
	"/import",
	requireCapability(capabilities.IMPORT_CASES),
	wrap(async (request, response) => {
		const data = z
			.object({
				kind: z.enum(["orders", "invoices"]),
				type: z.enum(["Pedido de venda", "Base de troca", "Garantia"]),
				refs: z.array(z.string().trim().min(1).max(30)).min(1).max(20)
			})
			.parse(request.body);
		return response.json(await omieImport.importRecords(request.user, data));
	})
);

router.get(
	"/orders/:number",
	requireCapability(capabilities.CREATE_CASE),
	wrap(async (request, response) => response.json({ order: await omie.lookupOrder(request.params.number) }))
);
router.get(
	"/invoices/:number",
	requireCapability(capabilities.CREATE_CASE),
	wrap(async (request, response) => response.json({ invoice: await omie.lookupInvoice(request.params.number) }))
);

module.exports = { router };
