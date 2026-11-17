// F14: pedidos e notas fiscais do Omie listados para a pessoa escolher quais viram processos.
const { database } = require("../db");
const { AppError } = require("../middleware/errors");
const { CASE_TYPES } = require("../domain/constants");
const { isValidDocument, onlyDigits } = require("../validators/document");
const omie = require("./omie");
const cases = require("./cases");

const PAGE_SIZE = 50;
const MAX_IMPORT = 20;

// "AAAA-MM-DD" (input date) -> "DD/MM/AAAA" (Omie).
const toOmieDate = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join("/") : null);
const clean = (value, max) => {
	const text = String(value ?? "").trim();
	return text ? text.slice(0, max) : "";
};
const validDocument = (value) => {
	const digits = onlyDigits(value);
	return digits && isValidDocument(digits) ? digits : "";
};

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

function mapOrder(order) {
	const header = order.cabecalho || {};
	const info = order.infoCadastro || {};
	const items = (order.det || [])
		.map((entry) => ({
			productCode: clean(entry.produto?.codigo, 80),
			description: clean(entry.produto?.descricao, 180),
			quantity: Math.max(1, Math.round(Number(entry.produto?.quantidade) || 1)),
			unitPrice: Number(entry.produto?.valor_unitario) || 0
		}))
		.filter((item) => item.productCode && item.description);
	return {
		ref: String(header.codigo_pedido),
		omieOrderCode: Number(header.codigo_pedido) || null,
		number: String(header.numero_pedido || ""),
		date: info.dInc || header.data_previsao || "",
		customerCode: Number(header.codigo_cliente) || null,
		stage: String(header.etapa || ""),
		invoiced: info.faturado === "S",
		cancelled: info.cancelado === "S",
		total: Number(order.total_pedido?.valor_total_pedido) || items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
		items
	};
}

function mapInvoice(invoice) {
	const ide = invoice.ide || {};
	const items = (invoice.det || [])
		.map((entry) => ({
			productCode: clean(entry.prod?.cProd, 80),
			description: clean(entry.prod?.xProd, 180),
			quantity: Math.max(1, Math.round(Number(entry.prod?.qCom) || 1)),
			unitPrice: Number(entry.prod?.vUnCom) || 0
		}))
		.filter((item) => item.productCode && item.description);
	return {
		ref: String(ide.nNF || "").replace(/^0+/, ""),
		number: String(ide.nNF || ""),
		series: String(ide.serie || ""),
		date: ide.dEmi || "",
		type: ide.tpNF === "0" ? "entrada" : "saida",
		purpose: String(ide.finNFe || ""),
		isReturn: String(ide.finNFe) === "4",
		omieOrderCode: Number(invoice.compl?.nIdPedido) || null,
		customerCode: Number(invoice.nfDestInt?.nCodCli) || null,
		customerName: clean(invoice.nfDestInt?.cRazao, 180),
		customerDocument: validDocument(invoice.nfDestInt?.cnpj_cpf),
		total: Number(invoice.total?.ICMSTot?.vNF) || 0,
		items
	};
}

// Completa nome e documento do cliente pelo cadastro sincronizado (sem chamar o Omie de novo).
async function attachCustomers(rows) {
	const codes = [...new Set(rows.map((row) => row.customerCode).filter(Boolean))];
	if (!codes.length) return rows;
	const { rows: customers } = await database.query("SELECT omie_code, name, document FROM customers WHERE omie_code = ANY($1::bigint[])", [codes]);
	const byCode = new Map(customers.map((customer) => [Number(customer.omie_code), customer]));
	return rows.map((row) => {
		const local = byCode.get(row.customerCode);
		return { ...row, customerName: row.customerName || local?.name || "", customerDocument: row.customerDocument || local?.document || "" };
	});
}

// Marca o que ja virou processo, para a tela nao deixar importar duas vezes.
async function attachExisting(rows, kind) {
	if (!rows.length) return rows;
	const column = kind === "orders" ? "omie_order_code::text" : "ltrim(omie_invoice_number, '0')";
	const { rows: found } = await database.query(`SELECT ${column} AS ref, case_number FROM cases WHERE ${column} = ANY($1::text[])`, [
		rows.map((row) => row.ref)
	]);
	const byRef = new Map();
	for (const item of found) byRef.set(item.ref, [...(byRef.get(item.ref) || []), item.case_number]);
	return rows.map((row) => ({ ...row, cases: byRef.get(row.ref) || [] }));
}

async function listOrders({ from, to, page }) {
	const result = await fetchPage("produtos/pedido", "ListarPedidos", { apenas_importado_api: "N", ...dateFilter(from, to) }, "pedido_venda_produto", page);
	const orders = await attachExisting(await attachCustomers(result.list.map(mapOrder)), "orders");
	return { orders, page: result.page, totalPages: result.totalPages, total: result.total };
}

async function listInvoices({ from, to, page, type }) {
	const base = { ...dateFilter(from, to), ...(type === "entrada" ? { tpNF: "0" } : type === "saida" ? { tpNF: "1" } : {}) };
	const result = await fetchPage("produtos/nfconsultar", "ListarNF", base, "nfCadastro", page);
	const invoices = await attachExisting(await attachCustomers(result.list.map(mapInvoice)), "invoices");
	return { invoices, page: result.page, totalPages: result.totalPages, total: result.total };
}

async function loadOrder(ref) {
	const data = await omie.call("produtos/pedido", "ConsultarPedido", { codigo_pedido: Number(ref) });
	if (!data.pedido_venda_produto?.cabecalho) throw new AppError(404, "Pedido nao encontrado no Omie.", "OMIE_NOT_FOUND");
	const [order] = await attachCustomers([mapOrder(data.pedido_venda_produto)]);
	return order;
}

async function loadInvoice(ref) {
	const number = Number(String(ref).replace(/\D/g, ""));
	const data = await omie.call("produtos/nfconsultar", "ListarNF", { pagina: 1, registros_por_pagina: 5, nNFInicial: number, nNFFinal: number });
	const invoice = (data.nfCadastro || []).find((entry) => String(entry.ide?.nNF).replace(/^0+/, "") === String(number));
	if (!invoice) throw new AppError(404, "Nota fiscal nao encontrada no Omie.", "OMIE_NOT_FOUND");
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

module.exports = { listOrders, listInvoices, importRecords, mapOrder, mapInvoice, toOmieDate };
