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

// Primeira carga completa ainda nao terminou: consulta ao vivo e dispara a carga em segundo plano
// (se ja estiver rodando, a nova tentativa so e ignorada).
async function mirrorEmpty(kind) {
	if (await omie.lastSuccess(kind)) return false;
	firstLoad = Promise.all([firstLoad, omie.runSync(kind, { trigger: "first-load" }).catch(() => {})]);
	return true;
}
let firstLoad = Promise.resolve();
// Promessa da carga inicial em segundo plano (os testes esperam por ela).
const idle = () => firstLoad;

// Ao vivo mostra so a pagina mais recente (a paginacao completa fica para quando o espelho carregar).
async function listOrdersLive({ from, to }) {
	const result = await fetchPage("produtos/pedido", "ListarPedidos", { apenas_importado_api: "N", ...dateFilter(from, to) }, "pedido_venda_produto");
	const orders = await attachExisting(await attachCustomers(result.list.map(mapOrder)), "orders");
	return { orders, page: 1, totalPages: 1, total: result.total, source: "live" };
}

async function listInvoicesLive({ from, to, type }) {
	const base = { ...dateFilter(from, to), ...(type === "entrada" ? { tpNF: "0" } : type === "saida" ? { tpNF: "1" } : {}) };
	const result = await fetchPage("produtos/nfconsultar", "ListarNF", base, "nfCadastro");
	const invoices = await attachExisting(await attachCustomers(result.list.map(mapInvoice)), "invoices");
	return { invoices, page: 1, totalPages: 1, total: result.total, source: "live" };
}

async function listOrders(query) {
	if (await mirrorEmpty("orders")) return listOrdersLive(query);
	return { ...(await mirror.list("orders", query)), source: "mirror" };
}

async function listInvoices(query) {
	if (await mirrorEmpty("invoices")) return listInvoicesLive(query);
	return { ...(await mirror.list("invoices", query)), source: "mirror" };
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
	const number = Number(String(ref).replace(/D/g, ""));
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
