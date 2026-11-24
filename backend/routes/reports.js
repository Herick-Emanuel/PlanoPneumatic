const crypto = require("node:crypto");
const express = require("express");
const { z } = require("zod");
const { database } = require("../db");
const { capabilities, can } = require("../domain/permissions");
const { requireAuth, requireCapability } = require("../middleware/auth");
const { wrap, forbidden, badRequest, notFound } = require("../middleware/errors");
const customReports = require("../services/customReports");
const { buildCaseFilters } = require("../services/caseFilters");
const reports = require("../services/reports");
const exportsService = require("../services/exports");
const reportSchedules = require("../services/reportSchedules");
const { listQuerySchema } = require("../validators/cases");

const router = express.Router();
router.use(requireAuth);

// Relatorios usam os mesmos filtros da lista, sem paginacao.
const filterQuery = listQuerySchema.omit({ sort: true, direction: true, page: true, pageSize: true });
const parseFilters = (request) => filterQuery.parse(request.query);
// Telas de relatorio: sem periodo informado, valem os ultimos 90 dias (period=all desliga o padrao).
const DEFAULT_REPORT_DAYS = 90;
function reportFilters(request) {
	const filters = parseFilters(request);
	if (!filters.from && !filters.to && request.query.period !== "all")
		filters.from = new Date(Date.now() - DEFAULT_REPORT_DAYS * 86400000).toISOString().slice(0, 10);
	return filters;
}

function htmlCell(value) {
	return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

router.get(
	"/summary",
	wrap(async (request, response) => response.json(await reports.reportsSummary(request.user, reportFilters(request))))
);
router.get(
	"/by-customer",
	wrap(async (request, response) => response.json({ rows: await reports.groupedReport(request.user, reportFilters(request), "customer") }))
);
router.get(
	"/by-product",
	wrap(async (request, response) => response.json({ rows: await reports.groupedReport(request.user, reportFilters(request), "product") }))
);

router.get(
	"/by-case/:caseNumber",
	wrap(async (request, response) => {
		const cases = require("../services/cases");
		const detail = await cases.getCaseDetail(request.user, String(request.params.caseNumber));
		return response.json({ case: detail });
	})
);

router.get(
	"/team-performance",
	requireCapability(capabilities.VIEW_TEAM_REPORTS),
	wrap(async (request, response) => response.json(await reports.teamPerformance(request.user, request.query)))
);
router.get(
	"/manager-performance",
	requireCapability(capabilities.VIEW_MANAGER_PERFORMANCE),
	wrap(async (request, response) => response.json({ managers: await reports.managerPerformance() }))
);
router.get(
	"/advanced",
	wrap(async (request, response) => response.json(await reports.advancedDashboard(request.user, parseFilters(request))))
);

router.put(
	"/team-goals/:managerId",
	requireCapability(capabilities.MANAGE_SETTINGS),
	wrap(async (request, response) => {
		const managerId = z.coerce.number().int().positive().parse(request.params.managerId);
		const { monthlyTarget } = z.object({ monthlyTarget: z.coerce.number().int().min(1).max(100000) }).parse(request.body);
		await database.query(
			"INSERT INTO team_goals (manager_id, monthly_target) VALUES ($1, $2) ON CONFLICT (manager_id) DO UPDATE SET monthly_target = EXCLUDED.monthly_target, updated_at = NOW()",
			[managerId, monthlyTarget]
		);
		return response.json({ managerId, monthlyTarget });
	})
);

function requireExport(request, response, next) {
	return can(request.user, capabilities.EXPORT_REPORTS) ? next() : next(forbidden());
}

router.get(
	"/export.csv",
	requireExport,
	wrap(async (request, response) => {
		const rows = await reports.exportRows(request.user, parseFilters(request));
		response.setHeader("Content-Type", "text/csv; charset=utf-8");
		response.setHeader("Content-Disposition", "attachment; filename=relatorio-processos.csv");
		return response.send(exportsService.toCsv(rows));
	})
);

router.get(
	"/export.xlsx",
	requireExport,
	wrap(async (request, response) => {
		const rows = await reports.exportRows(request.user, parseFilters(request));
		response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		response.setHeader("Content-Disposition", "attachment; filename=relatorio-processos.xlsx");
		return response.send(await exportsService.toXlsx(rows));
	})
);

router.get(
	"/export.pdf",
	requireExport,
	wrap(async (request, response) => {
		const rows = await reports.exportRows(request.user, parseFilters(request));
		response.setHeader("Content-Type", "application/pdf");
		response.setHeader("Content-Disposition", "attachment; filename=relatorio-processos.pdf");
		return response.send(await exportsService.toPdf(rows));
	})
);

router.get(
	"/export.html",
	requireExport,
	wrap(async (request, response) => {
		const rows = (await reports.exportRows(request.user, parseFilters(request))).slice(0, 1000);
		const rowsHtml = rows
			.map(
				(item) =>
					`<tr><td>${htmlCell(item.case_number)}</td><td>${htmlCell(item.client)}</td><td>${htmlCell(item.type)}</td><td>${htmlCell(item.status)}</td><td>${htmlCell(item.responsible)}</td><td>${htmlCell(new Date(item.updated_at).toLocaleString("pt-BR"))}</td></tr>`
			)
			.join("");
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		// Pagina avulsa de impressao: estilo e script liberados so por nonce (sem 'unsafe-inline').
		const nonce = crypto.randomBytes(16).toString("base64");
		response.setHeader(
			"Content-Security-Policy",
			`default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
		);
		return response.send(
			`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatorio de processos</title><style nonce="${nonce}">body{font:14px Arial;color:#17283a}h1{color:#092d57}table{border-collapse:collapse;width:100%}th,td{border:1px solid #dfe7ef;padding:8px;text-align:left}th{background:#f1f5f8}@media print{button{display:none}}</style></head><body><button type="button" id="print">Imprimir / salvar PDF</button><script nonce="${nonce}">document.getElementById("print").addEventListener("click", () => window.print());</script><h1>Relatorio de processos</h1><table><thead><tr><th>Processo</th><th>Cliente</th><th>Tipo</th><th>Status</th><th>Responsavel</th><th>Atualizado</th></tr></thead><tbody>${rowsHtml}</tbody></table></body></html>`
		);
	})
);
// Exportar a tabela que esta na tela (cada relatorio): os dados ja vieram da API com o escopo da pessoa;
// aqui so viram arquivo. Celulas sao texto/numero curtos e as formulas sao neutralizadas na exportacao.
const cellSchema = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
const tableExportSchema = z.object({
	title: z.string().trim().min(1).max(120),
	format: z.enum(["xlsx", "pdf", "csv"]),
	columns: z
		.array(z.object({ key: z.string().min(1).max(60), header: z.string().max(120), width: z.number().int().min(4).max(80).optional() }))
		.min(1)
		.max(40),
	rows: z.array(z.record(z.string(), cellSchema)).max(5000)
});
const fileSlug = (title) =>
	String(title)
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60) || "relatorio";
async function sendTable(response, format, columns, rows, title) {
	const file = await exportsService.exportTable(format, columns, rows, title);
	response.setHeader("Content-Type", file.type);
	response.setHeader("Content-Disposition", `attachment; filename=${fileSlug(title)}.${format}`);
	return response.send(file.buffer);
}
router.post(
	"/table-export",
	requireExport,
	wrap(async (request, response) => {
		const data = tableExportSchema.parse(request.body);
		return sendTable(response, data.format, data.columns, data.rows, data.title);
	})
);

// Abrir planilha exportada antes (somente leitura, para conferir/comparar na tela). CSV e lido no navegador.
router.post(
	"/import-sheet",
	requireExport,
	wrap(async (request, response) => {
		const { content } = z.object({ fileName: z.string().max(200).optional(), content: z.string().min(1).max(8_000_000) }).parse(request.body);
		const buffer = Buffer.from(content, "base64");
		// XLSX e um ZIP: confere a assinatura antes de entregar ao leitor.
		if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw badRequest("Arquivo invalido: envie uma planilha .xlsx ou .csv.");
		try {
			return response.json(await exportsService.readXlsx(buffer));
		} catch {
			throw badRequest("Nao foi possivel ler a planilha. Confira se o arquivo e um .xlsx valido.");
		}
	})
);

// Construtor de relatorios (administrador e gerente) com modelos salvos.
const requireBuilder = requireCapability(capabilities.BUILD_REPORTS);
const templateId = (request) => z.coerce.number().int().positive().parse(request.params.id);
router.get(
	"/custom/catalog",
	requireBuilder,
	wrap(async (request, response) => response.json({ sources: customReports.catalog() }))
);
router.post(
	"/custom/preview",
	requireBuilder,
	wrap(async (request, response) => {
		const result = await customReports.run(request.user, request.body?.definition, { limit: 200 });
		return response.json({ columns: result.columns, rows: result.rows, truncated: result.truncated });
	})
);
router.post(
	"/custom/export",
	requireBuilder,
	requireExport,
	wrap(async (request, response) => {
		const { format, title } = z
			.object({ format: z.enum(["xlsx", "pdf", "csv"]), title: z.string().trim().max(120).optional() })
			.parse({ format: request.body?.format, title: request.body?.title });
		const result = await customReports.run(request.user, request.body?.definition, { limit: 5000 });
		return sendTable(response, format, result.columns, result.rows, title || "Relatorio personalizado");
	})
);
router.get(
	"/templates",
	requireBuilder,
	wrap(async (request, response) => response.json({ templates: await customReports.listTemplates(request.user) }))
);
router.post(
	"/templates",
	requireBuilder,
	wrap(async (request, response) => {
		if ((await customReports.countTemplates(request.user)) >= 50) throw forbidden("Limite de 50 modelos por pessoa.");
		return response.status(201).json({ template: await customReports.createTemplate(request.user, request.body) });
	})
);
router.put(
	"/templates/:id",
	requireBuilder,
	wrap(async (request, response) => {
		const template = await customReports.updateTemplate(request.user, templateId(request), request.body);
		if (!template) throw notFound("Modelo nao encontrado (so quem criou pode alterar).");
		return response.json({ template });
	})
);
router.delete(
	"/templates/:id",
	requireBuilder,
	wrap(async (request, response) => {
		if (!(await customReports.removeTemplate(request.user, templateId(request)))) throw notFound("Modelo nao encontrado (so quem criou pode excluir).");
		return response.status(204).send();
	})
);

// F11: envios agendados por e-mail (cada pessoa gerencia os proprios).
const scheduleSchema = z.object({
	name: z.string().trim().min(1, "Informe um nome.").max(80),
	format: z.enum(["xlsx", "pdf", "csv"]),
	frequency: z.enum(["daily", "weekly", "monthly"]),
	weekday: z.coerce.number().int().min(0).max(6).optional(),
	hour: z.coerce.number().int().min(0).max(23).default(7),
	filters: filterQuery.omit({ from: true, to: true }).default({})
});
const withLabel = (schedule) => ({ ...schedule, description: reportSchedules.describe(schedule) });
router.get(
	"/schedules",
	requireExport,
	wrap(async (request, response) => response.json({ schedules: (await reportSchedules.list(request.user.id)).map(withLabel) }))
);
router.post(
	"/schedules",
	requireExport,
	wrap(async (request, response) => {
		const data = scheduleSchema.parse(request.body);
		if ((await reportSchedules.list(request.user.id)).length >= 10) throw forbidden("Limite de 10 envios agendados por pessoa.");
		return response.status(201).json({ schedule: withLabel(await reportSchedules.create(request.user.id, data)) });
	})
);
router.patch(
	"/schedules/:id",
	requireExport,
	wrap(async (request, response) => {
		const { active } = z.object({ active: z.boolean() }).parse(request.body);
		const schedule = await reportSchedules.update(request.user.id, Number(request.params.id), { active });
		if (!schedule) return response.status(404).json({ message: "Agendamento nao encontrado.", code: "NOT_FOUND" });
		return response.json({ schedule: withLabel(schedule) });
	})
);
router.delete(
	"/schedules/:id",
	requireExport,
	wrap(async (request, response) => {
		if (!(await reportSchedules.remove(request.user.id, Number(request.params.id))))
			return response.status(404).json({ message: "Agendamento nao encontrado.", code: "NOT_FOUND" });
		return response.status(204).send();
	})
);
router.post(
	"/schedules/:id/send",
	requireExport,
	wrap(async (request, response) => {
		const owned = (await reportSchedules.list(request.user.id)).some((schedule) => schedule.id === Number(request.params.id));
		if (!owned) return response.status(404).json({ message: "Agendamento nao encontrado.", code: "NOT_FOUND" });
		const result = await reportSchedules.deliver(Number(request.params.id));
		return response.status(result.sent ? 200 : 422).json(result.sent ? result : { message: result.error, code: "SEND_FAILED" });
	})
);

module.exports = { router, buildCaseFilters };
