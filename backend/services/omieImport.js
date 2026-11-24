// F14: pedidos e notas fiscais do Omie listados para a pessoa escolher quais viram processos.
// As listas vem do espelho local (omieMirror); so enquanto o espelho ainda esta vazio (primeira carga
// em andamento) a tela consulta o Omie ao vivo.
const { database } = require("../db");
const { AppError } = require("../middleware/errors");
const { CASE_TYPES } = require("../domain/constants");
const omie = require("./omie");
const mirror = require("./omieMirror");
const cases = require("./cases");

const PAGE_SIZE = 50;
const MAX_IMPORT = 20;

// "AAAA-MM-DD" (input date) -> "DD/MM/AAAA" (Omie).
const toOmieDate = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join("/") : null);
function dateFilter(from, to) {
	const filter = {};
	if (toOmieDate(from)) filter.filtrar_por_data_de = toOmieDate(from);
	if (toOmieDate(to)) filter.filtrar_por_data_ate = toOmieDate(to);
	return filter;
}

// O Omie lista do mais antigo para o mais novo: sem pagina pedida, abre na ultima (os mais recentes).
async function fetchPage(endpoint, method, base, listKey, page) {
	let data = await omie.call(endpoint, method, { pagina: page || 1, registros_por_pagina: PAGE_SIZE, ...base });
	const totalPages = data.total_de_paginas || 1;
	if (!page && totalPages > 1) data = await omie.call(endpoint, method, { pagina: totalPages, registros_por_pagina: PAGE_SIZE, ...base });
	return { list: [...(data[listKey] || [])].reverse(), page: page || totalPages, totalPages, total: data.total_de_registros || 0 };
}

const { mapOrder, mapInvoice, attachCustomers, attachExisting } = mirror;

// De onde a tela le, sem nunca esperar pelo Omie:
//  - "mirror": carga completa feita -> so banco;
//  - "loading": carga inicial em andamento -> o que ja chegou (a carga traz os mais recentes primeiro);
//  - "live": espelho ainda vazio -> pagina mais recente direto do Omie (com cache), ou "waiting" se o Omie pedir intervalo.
let firstLoad = Promise.resolve();
// Promessa da carga inicial em segundo plano (os testes esperam por ela).
const idle = () => firstLoad;
async function readSource(kind) {
	if (await omie.lastSuccess(kind)) return "mirror";
	firstLoad = Promise.all([firstLoad, omie.runSync(kind, { trigger: "first-load" }).catch(() => {})]);
	const { rows } = await database.query(`SELECT EXISTS (SELECT 1 FROM ${kind === "orders" ? "omie_orders" : "omie_invoices"}) AS has`);
	return rows[0].has ? "loading" : "live";
}

// O Omie bloqueia a mesma consulta repetida em menos de 60 s ("consumo redundante"): a resposta ao vivo
// fica guardada por 90 s, e quem abrir/recarregar a tela nesse intervalo recebe a copia.
const LIVE_TTL = 90000;
const liveCache = new Map();
async function cachedLive(key, loader) {
	const hit = liveCache.get(key);
	if (hit && Date.now() - hit.at < LIVE_TTL) return hit.value;
	const value = await loader();
	liveCache.set(key, { at: Date.now(), value });
	for (const [entry, item] of liveCache) if (Date.now() - item.at >= LIVE_TTL) liveCache.delete(entry);
	return value;
}
// Omie pediu intervalo (ou esta ocupado): a tela mostra aviso e tenta de novo sozinha, sem erro.
async function liveOrWait(kind, key, loader) {
	try {
		return await cachedLive(key, loader);
	} catch (error) {
		if (!["OMIE_RATE_LIMIT", "OMIE_UNREACHABLE"].includes(error.code) && !/requisi[cç][aã]o desse m[eé]todo/i.test(error.message)) throw error;
		const retryAfter = Number(/(\d+) segundos/.exec(error.message)?.[1]) || 15;
		return { [kind]: [], page: 1, totalPages: 1, total: 0, source: "waiting", retryAfter: Math.min(60, retryAfter + 2) };
	}
}

// Ao vivo mostra so a pagina mais recente (a paginacao completa fica para quando o espelho carregar).
const listOrdersLive = ({ from, to }) =>
	liveOrWait("orders", `orders:${from}:${to}`, async () => {
		const result = await fetchPage("produtos/pedido", "ListarPedidos", { apenas_importado_api: "N", ...dateFilter(from, to) }, "pedido_venda_produto");
		const orders = await attachCustomers(result.list.map(mapOrder));
		return { orders, page: 1, totalPages: 1, total: result.total, source: "live" };
	});

const listInvoicesLive = ({ from, to, type }) =>
	liveOrWait("invoices", `invoices:${from}:${to}:${type}`, async () => {
		const base = { ...dateFilter(from, to), ...(type === "entrada" ? { tpNF: "0" } : type === "saida" ? { tpNF: "1" } : {}) };
		const result = await fetchPage("produtos/nfconsultar", "ListarNF", base, "nfCadastro");
		const invoices = await attachCustomers(result.list.map(mapInvoice));
		return { invoices, page: 1, totalPages: 1, total: result.total, source: "live" };
	});

async function listOrders(query) {
	const source = await readSource("orders");
	if (source !== "live") return { ...(await mirror.list("orders", query)), source };
	const result = await listOrdersLive(query);
	return { ...result, orders: await attachExisting(result.orders, "orders") };
}

async function listInvoices(query) {
	const source = await readSource("invoices");
	if (source !== "live") return { ...(await mirror.list("invoices", query)), source };
	const result = await listInvoicesLive(query);
	return { ...result, invoices: await attachExisting(result.invoices, "invoices") };
}

// Do espelho quando ja estiver la; senao consulta o Omie e guarda no espelho.
async function loadOrder(ref) {
	const cached = await mirror.findOrder(ref);
	if (cached) return cached;
	const data = await omie.call("produtos/pedido", "ConsultarPedido", { codigo_pedido: Number(ref) });
	if (!data.pedido_venda_produto?.cabecalho) throw new AppError(404, "Pedido nao encontrado no Omie.", "OMIE_NOT_FOUND");
	await mirror.upsertOrder(data.pedido_venda_produto);
	const [order] = await attachCustomers([mapOrder(data.pedido_venda_produto)]);
	return order;
}

async function loadInvoice(ref) {
	const cached = await mirror.findInvoice(ref);
	if (cached) return cached;
	const number = Number(String(ref).replace(/[^0-9]/g, ""));
	const data = await omie.call("produtos/nfconsultar", "ListarNF", { pagina: 1, registros_por_pagina: 5, nNFInicial: number, nNFFinal: number });
	const invoice = (data.nfCadastro || []).find((entry) => String(entry.ide?.nNF).replace(/^0+/, "") === String(number));
	if (!invoice) throw new AppError(404, "Nota fiscal nao encontrada no Omie.", "OMIE_NOT_FOUND");
	await mirror.upsertInvoice(invoice);
	const [mapped] = await attachCustomers([mapInvoice(invoice)]);
	return mapped;
}

/**
 * Cria um processo por registro escolhido. Cada linha e independente: um erro nao impede as outras.
 * kind = "orders" | "invoices"; type = tipo de processo a criar.
 */
async function importRecords(user, { kind, type, refs }) {
	if (!CASE_TYPES.includes(type)) throw new AppError(400, "Tipo de processo invalido.", "BAD_TYPE");
	if (!Array.isArray(refs) || !refs.length || refs.length > MAX_IMPORT)
		throw new AppError(400, `Escolha de 1 a ${MAX_IMPORT} registros por vez.`, "BAD_SELECTION");
	const results = [];
	for (const ref of refs) {
		try {
			const record = kind === "orders" ? await loadOrder(ref) : await loadInvoice(ref);
			const [existing] = (await attachExisting([record], kind))[0].cases;
			if (existing) {
				results.push({ ref, status: "skipped", message: `Ja importado como ${existing}.`, caseNumber: existing });
				continue;
			}
			if (!record.items.length) {
				results.push({ ref, status: "error", message: "Sem itens com codigo e descricao." });
				continue;
			}
			if (!record.customerName) {
				results.push({ ref, status: "error", message: "Cliente nao encontrado no cadastro; sincronize os clientes do Omie." });
				continue;
			}
			const first = record.items[0];
			const label = kind === "orders" ? `Pedido Omie ${record.number}` : `NF ${record.number}`;
			const created = await cases.createCase(user, {
				type,
				intake: true,
				client: record.customerName,
				clientDocument: record.customerDocument || undefined,
				product: first.description,
				productCode: first.productCode,
				quantity: first.quantity,
				unitPrice: type === "Pedido de venda" ? first.unitPrice : undefined,
				documentReference: label,
				notes: `Importado do Omie (${label}${record.date ? `, ${record.date}` : ""}).`,
				items: type === "Pedido de venda" && record.items.length > 1 ? record.items : undefined
			});
			await database.query("UPDATE cases SET omie_order_code = $2, omie_order_number = $3, omie_invoice_number = $4 WHERE id = $1", [
				created.id,
				record.omieOrderCode,
				kind === "orders" ? record.number : null,
				kind === "invoices" ? record.number : null
			]);
			await cases.addEvent(database, created.id, "VALIDACAO", `Processo aberto a partir do Omie (${label})`, user);
			results.push({ ref, status: "created", caseNumber: created.case_number });
		} catch (error) {
			if (!(error instanceof AppError)) throw error;
			results.push({ ref, status: "error", message: error.message });
		}
	}
	return { results, created: results.filter((entry) => entry.status === "created").length };
}

module.exports = { listOrders, listInvoices, importRecords, mapOrder, mapInvoice, toOmieDate, idle };
