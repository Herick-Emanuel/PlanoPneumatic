const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const { STATUS_LABELS } = require("../domain/constants");

const COLUMNS = [
	{ key: "case_number", header: "Processo", width: 18 },
	{ key: "client", header: "Cliente", width: 32 },
	{ key: "client_document", header: "Documento", width: 18 },
	{ key: "type", header: "Tipo", width: 18 },
	{ key: "status", header: "Status", width: 22 },
	{ key: "responsible", header: "Responsavel", width: 22 },
	{ key: "product", header: "Produto", width: 30 },
	{ key: "product_code", header: "Codigo", width: 14 },
	{ key: "quantity", header: "Qtd", width: 8 },
	{ key: "document_reference", header: "Documento de origem", width: 22 },
	{ key: "due_at", header: "Prazo", width: 18 },
	{ key: "updated_at", header: "Atualizado", width: 18 }
];

const formatDateTime = (value) => (value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "");

function cellValue(row, key) {
	if (key === "status") return STATUS_LABELS[row.status] || row.status;
	if (key === "due_at" || key === "updated_at" || key === "created_at") return formatDateTime(row[key]);
	return row[key] ?? "";
}

// Neutraliza formulas em planilhas (CSV/XLSX injection).
const safeCell = (value) => (typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

function toCsv(rows) {
	const quote = (value) => `"${String(safeCell(value) ?? "").replace(/"/g, '""')}"`;
	const lines = [
		COLUMNS.map((column) => quote(column.header)).join(";"),
		...rows.map((row) => COLUMNS.map((column) => quote(cellValue(row, column.key))).join(";"))
	];
	return `\ufeff${lines.join("\n")}`;
}

async function toXlsx(rows, title = "Processos") {
	const workbook = new ExcelJS.Workbook();
	workbook.creator = "Plano Pneumatic";
	const sheet = workbook.addWorksheet(title);
	sheet.columns = COLUMNS.map((column) => ({ header: column.header, key: column.key, width: column.width }));
	sheet.getRow(1).font = { bold: true };
	sheet.views = [{ state: "frozen", ySplit: 1 }];
	for (const row of rows) sheet.addRow(Object.fromEntries(COLUMNS.map((column) => [column.key, safeCell(cellValue(row, column.key))])));
	return Buffer.from(await workbook.xlsx.writeBuffer());
}

function toPdf(rows, title = "Relatorio de processos") {
	return new Promise((resolve, reject) => {
		const document = new PDFDocument({ size: "A4", layout: "landscape", margin: 30 });
		const chunks = [];
		document.on("data", (chunk) => chunks.push(chunk));
		document.on("end", () => resolve(Buffer.concat(chunks)));
		document.on("error", reject);
		document.fontSize(16).text(title);
		document
			.fontSize(9)
			.fillColor("#555")
			.text(`Gerado em ${formatDateTime(new Date())} - ${rows.length} processo(s)`)
			.fillColor("#000")
			.moveDown();
		const columns = [
			["case_number", 90],
			["client", 190],
			["type", 90],
			["status", 100],
			["responsible", 110],
			["updated_at", 110]
		];
		const drawRow = (values, bold = false) => {
			const y = document.y;
			if (y > document.page.height - 50) {
				document.addPage();
			}
			let x = 30;
			const top = document.y;
			document.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
			for (const [index, [, width]] of columns.entries()) {
				document.text(String(values[index] ?? "").slice(0, 60), x, top, { width: width - 4, lineBreak: false });
				x += width;
			}
			document.y = top + 14;
		};
		drawRow(["Processo", "Cliente", "Tipo", "Status", "Responsavel", "Atualizado"], true);
		for (const row of rows) drawRow(columns.map(([key]) => cellValue(row, key)));
		document.end();
	});
}

// ---- Tabelas genericas (relatorios da tela e construtor): colunas [{ key, header, width? }] e linhas ja formatadas.
const plainValue = (value) => (value === null || value === undefined ? "" : value instanceof Date ? formatDateTime(value) : value);

function tableToCsv(columns, rows) {
	const quote = (value) => `"${String(safeCell(plainValue(value))).replace(/"/g, '""')}"`;
	const lines = [columns.map((column) => quote(column.header)).join(";"), ...rows.map((row) => columns.map((column) => quote(row[column.key])).join(";"))];
	return `${String.fromCharCode(0xfeff)}${lines.join("\n")}`;
}

async function tableToXlsx(columns, rows, title = "Relatorio") {
	const workbook = new ExcelJS.Workbook();
	workbook.creator = "Plano Pneumatic";
	const sheet = workbook.addWorksheet(
		String(title)
			.replace(/[\\/?*[\]:]/g, " ")
			.slice(0, 31) || "Relatorio"
	);
	sheet.columns = columns.map((column) => ({
		header: column.header,
		key: column.key,
		width: column.width || Math.min(40, Math.max(10, String(column.header).length + 4))
	}));
	sheet.getRow(1).font = { bold: true };
	sheet.views = [{ state: "frozen", ySplit: 1 }];
	for (const row of rows) sheet.addRow(Object.fromEntries(columns.map((column) => [column.key, safeCell(plainValue(row[column.key]))])));
	return Buffer.from(await workbook.xlsx.writeBuffer());
}

function tableToPdf(columns, rows, title = "Relatorio") {
	return new Promise((resolve, reject) => {
		const document = new PDFDocument({ size: "A4", layout: "landscape", margin: 30 });
		const chunks = [];
		document.on("data", (chunk) => chunks.push(chunk));
		document.on("end", () => resolve(Buffer.concat(chunks)));
		document.on("error", reject);
		document.fontSize(16).text(title);
		document
			.fontSize(9)
			.fillColor("#555")
			.text(`Gerado em ${formatDateTime(new Date())} - ${rows.length} linha(s)`)
			.fillColor("#000")
			.moveDown();
		const width = (document.page.width - 60) / Math.max(columns.length, 1);
		const maxChars = Math.max(8, Math.floor(width / 4.4));
		const fontSize = columns.length > 10 ? 6.5 : 8;
		const drawRow = (values, bold) => {
			if (document.y > document.page.height - 50) document.addPage();
			const top = document.y;
			document.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
			values.forEach((value, index) =>
				document.text(String(plainValue(value)).slice(0, maxChars), 30 + index * width, top, { width: width - 4, lineBreak: false })
			);
			document.y = top + 14;
		};
		drawRow(
			columns.map((column) => column.header),
			true
		);
		for (const row of rows)
			drawRow(
				columns.map((column) => row[column.key]),
				false
			);
		document.end();
	});
}

const EXPORT_TYPES = Object.freeze({
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pdf: "application/pdf",
	csv: "text/csv; charset=utf-8"
});

async function exportTable(format, columns, rows, title) {
	if (format === "xlsx") return { buffer: await tableToXlsx(columns, rows, title), type: EXPORT_TYPES.xlsx };
	if (format === "pdf") return { buffer: await tableToPdf(columns, rows, title), type: EXPORT_TYPES.pdf };
	return { buffer: Buffer.from(tableToCsv(columns, rows), "utf8"), type: EXPORT_TYPES.csv };
}

// Le a primeira aba de um XLSX (planilha exportada antes) como { columns, rows } de texto/numero.
async function readXlsx(buffer, maxRows = 5000) {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer);
	const sheet = workbook.worksheets[0];
	if (!sheet) return { columns: [], rows: [], truncated: false };
	const text = (cell) => {
		const value = cell.value;
		if (value === null || value === undefined) return "";
		if (value instanceof Date) return formatDateTime(value);
		if (typeof value === "object") return String(value.text ?? value.result ?? value.richText?.map((part) => part.text).join("") ?? "");
		return value;
	};
	const columns = [];
	sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, index) => columns.push({ index, header: String(text(cell)).trim() || `Coluna ${index}` }));
	const rows = [];
	let truncated = false;
	sheet.eachRow({ includeEmpty: false }, (row, number) => {
		if (number === 1) return;
		if (rows.length >= maxRows) {
			truncated = true;
			return;
		}
		rows.push(columns.map((column) => text(row.getCell(column.index))));
	});
	return { columns: columns.map((column) => column.header), rows, truncated };
}

module.exports = { toCsv, toXlsx, toPdf, safeCell, COLUMNS, tableToCsv, tableToXlsx, tableToPdf, exportTable, readXlsx, formatDateTime, EXPORT_TYPES };
