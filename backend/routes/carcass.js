// Controle de carcacas (aba de Base de troca): saldo por cliente/representante, lancamentos e prazo.
const express = require("express");
const { z } = require("zod");
const { capabilities, can } = require("../domain/permissions");
const { requireAuth, requireCapability } = require("../middleware/auth");
const { wrap, forbidden } = require("../middleware/errors");
const carcass = require("../services/carcass");
const settings = require("../services/settings");
const { audit } = require("../services/audit");

const router = express.Router();
router.use(requireAuth);
// Leitura: quem opera processos ou audita.
router.use((request, response, next) =>
	can(request.user, capabilities.CREATE_CASE) || can(request.user, capabilities.VIEW_ALL_CASES) ? next() : next(forbidden())
);

const id = z.coerce.number().int().positive();
const flag = z.enum(["true", "false"]).optional();

router.get(
	"/summary",
	wrap(async (request, response) => {
		const query = z
			.object({
				groupBy: z.enum(["customer", "representative"]).default("customer"),
				q: z.string().trim().max(120).optional(),
				representativeId: id.optional(),
				customerId: id.optional(),
				all: flag,
				overdue: flag
			})
			.parse(request.query);
		return response.json(
			await carcass.summary({
				groupBy: query.groupBy,
				q: query.q,
				representativeId: query.representativeId,
				customerId: query.customerId,
				onlyOpen: query.all !== "true",
				onlyOverdue: query.overdue === "true"
			})
		);
	})
);

router.get(
	"/entries",
	wrap(async (request, response) => {
		const query = z
			.object({
				customerId: id.optional(),
				representativeId: id.optional(),
				productCode: z.string().trim().max(80).optional(),
				kind: z.enum(["debit", "return", "adjustment"]).optional(),
				q: z.string().trim().max(120).optional(),
				page: z.coerce.number().int().min(1).max(100000).default(1)
			})
			.parse(request.query);
		return response.json(await carcass.listEntries(query));
	})
);

router.post(
	"/entries",
	requireCapability(capabilities.MANAGE_CARCASS),
	wrap(async (request, response) => response.status(201).json({ entry: await carcass.createEntry(request.user, request.body) }))
);

router.post(
	"/entries/:id/reverse",
	requireCapability(capabilities.REVERSE_CARCASS),
	wrap(async (request, response) => {
		const { reason } = z.object({ reason: z.string().trim().min(3, "Informe o motivo do estorno.").max(240) }).parse(request.body || {});
		return response.json({ entry: await carcass.reverseEntry(request.user, id.parse(request.params.id), reason) });
	})
);

// Prazo padrao de devolucao e inicio do debito automatico pelas notas do Omie.
router.get(
	"/config",
	wrap(async (request, response) =>
		response.json({
			dueDays: await carcass.dueDays(),
			omieStart: await settings.get("carcass_omie_start", null),
			canEdit: can(request.user, capabilities.REVERSE_CARCASS)
		})
	)
);
router.put(
	"/config",
	requireCapability(capabilities.REVERSE_CARCASS),
	wrap(async (request, response) => {
		const data = z
			.object({
				dueDays: z.coerce.number().int().min(1, "Prazo minimo de 1 dia.").max(365),
				omieStart: z
					.string()
					.regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "Data invalida.")
					.nullable()
					.or(z.literal("").transform(() => null))
			})
			.parse(request.body);
		await settings.set("carcass_due_days", data.dueDays, request.user.id);
		await settings.set("carcass_omie_start", data.omieStart, request.user.id);
		await audit("Configuração de carcaças alterada", { actorId: request.user.id, entityType: "setting", entityId: "carcass", details: data });
		return response.json(data);
	})
);

module.exports = { router };
