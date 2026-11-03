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
	const lines = [COLUMNS.map((column) => quote(column.header)).join(";"), ...rows.map((row) => COLUMNS.map((column) => quote(cellValue(row, column.key))).join(";"))];
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
		document.fontSize(9).fillColor("#555").text(`Gerado em ${formatDateTime(new Date())} - ${rows.length} processo(s)`).fillColor("#000").moveDown();
		const columns = [["case_number", 90], ["client", 190], ["type", 90], ["status", 100], ["responsible", 110], ["updated_at", 110]];
		const drawRow = (values, bold = false) => {
			const y = document.y;
			if (y > document.page.height - 50) { document.addPage(); }
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

module.exports = { toCsv, toXlsx, toPdf, safeCell, COLUMNS };
