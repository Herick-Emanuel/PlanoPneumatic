const { database, withTransaction } = require("../db");
const { CASE_PREFIX, CHECKLIST_TEMPLATES, FINISHED_STATUSES, PAUSING_STATUS, STATUS_LABELS, roles } = require("../domain/constants");
const { can, capabilities } = require("../domain/permissions");
const { allowedTransitions, validateTransition, FINAL_STATUSES, REOPEN_TARGET } = require("../domain/workflow");
const { AppError, badRequest, conflict, forbidden, notFound } = require("../middleware/errors");
const { buildCaseFilters } = require("./caseFilters");
const { getSlaDays, slaState } = require("./sla");
const { notifyCaseParticipants, notifyUser } = require("./notifications");
const { dispatchWebhook } = require("./webhooks");
const settings = require("./settings");

const FIELD_COLUMNS = Object.freeze({
	client: "client", clientDocument: "client_document", product: "product", productCode: "product_code", quantity: "quantity",
	documentReference: "document_reference", notes: "notes", customerId: "customer_id", productId: "product_id",
	salesRepresentative: "sales_representative", unitPrice: "unit_price", paymentTerms: "payment_terms", salesChannel: "sales_channel",
	exchangeReason: "exchange_reason", itemCondition: "item_condition", originOrder: "origin_order", trackingCode: "tracking_code",
	receivedAt: "received_at", defectDescription: "defect_description", riskLevel: "risk_level", serialNumber: "serial_number",
	lotNumber: "lot_number", technicalReport: "technical_report", technicalOwnerId: "technical_owner_id",
	warrantyDestination: "warranty_destination", logisticsStatus: "logistics_status"
});
const TECHNICAL_FIELDS = ["technicalReport", "technicalOwnerId", "warrantyDestination"];
const LOGISTICS_FIELDS = ["logisticsStatus"];
const SORT_COLUMNS = Object.freeze({ case_number: "c.case_number", client: "c.client", type: "c.type", status: "c.status", updated_at: "c.updated_at", created_at: "c.created_at", due_at: "c.due_at" });
const ASSIGNABLE_ROLES = [roles.OPERATOR, roles.TECHNICIAN, roles.LOGISTICS];

function formatDate(value) {
	return value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "";
}

function formatCase(item) {
	return {
		id: item.case_number,
		client: item.client,
		type: item.type,
		status: item.status,
		responsible: item.responsible,
		clientDocument: item.client_document || "",
		product: item.product || "Nao informado",
		productCode: item.product_code || "Nao informado",
		quantity: item.quantity || 0,
		documentReference: item.document_reference || "",
		notes: item.notes || "",
		updatedAt: formatDate(item.updated_at),
		updatedAtIso: item.updated_at ? new Date(item.updated_at).toISOString() : null,
		createdAtIso: item.created_at ? new Date(item.created_at).toISOString() : null,
		dueAt: item.due_at ? new Date(item.due_at).toISOString() : null,
		sla: slaState(item),
		slaPaused: Boolean(item.sla_paused_at),
		archived: Boolean(item.archived_at)
	};
}

function formatCaseDetail(item) {
	return {
		...formatCase(item),
		assignedTo: item.assigned_to,
		createdBy: item.created_by,
		customerId: item.customer_id,
		productId: item.product_id,
		salesRepresentative: item.sales_representative || "",
		unitPrice: item.unit_price === null || item.unit_price === undefined ? "" : Number(item.unit_price),
		paymentTerms: item.payment_terms || "",
		salesChannel: item.sales_channel || "",
		exchangeReason: item.exchange_reason || "",
		itemCondition: item.item_condition || "",
		originOrder: item.origin_order || "",
		trackingCode: item.tracking_code || "",
		receivedAt: item.received_at ? new Date(item.received_at).toISOString().slice(0, 10) : "",
		defectDescription: item.defect_description || "",
		riskLevel: item.risk_level || "",
		serialNumber: item.serial_number || "",
		lotNumber: item.lot_number || "",
		logisticsStatus: item.logistics_status || "",
		statusReason: item.status_reason || "",
		technicalReport: item.technical_report || "",
		warrantyDecision: item.warranty_decision || "",
		warrantyDestination: item.warranty_destination || "",
		technicalOwnerId: item.technical_owner_id,
		decidedAt: item.decided_at,
		closedAt: item.closed_at,
		reopenCount: item.reopen_count
	};
}

async function nextCaseNumber(db, type) {
	const prefix = CASE_PREFIX[type];
	const year = Number(new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 4));
	const { rows } = await db.query(
		"INSERT INTO case_sequences (prefix, year, last_value) VALUES ($1, $2, 1) ON CONFLICT (prefix, year) DO UPDATE SET last_value = case_sequences.last_value + 1 RETURNING last_value",
		[prefix, year]
	);
	return `${prefix}-${year}-${String(rows[0].last_value).padStart(4, "0")}`;
}

async function addEvent(db, caseId, type, description, user, details = null) {
	await db.query(
		"INSERT INTO case_events (case_id, event_type, description, responsible, actor_id, details) VALUES ($1, $2, $3, $4, $5, $6)",
		[caseId, type, description, user.name, user.id, details ? JSON.stringify(details) : null]
	);
}

function canView(user, item) {
	return can(user, capabilities.VIEW_ALL_CASES) || item.created_by === user.id || item.assigned_to === user.id;
}

async function findCase(caseNumber, user, { db = database, lock = false, includeArchived = true } = {}) {
	const { rows } = await db.query(`SELECT * FROM cases WHERE case_number = $1 ${lock ? "FOR UPDATE" : ""}`, [caseNumber]);
	const item = rows[0];
	if (!item || !canView(user, item) || (!includeArchived && item.archived_at)) throw notFound("Processo nao encontrado.");
	return item;
}

function duplicateOriginError(error, documentReference) {
	if (error.code === "23505" && error.constraint === "cases_origin_document_unique") {
		return conflict(`Ja existe um processo deste tipo com o documento de origem "${documentReference}".`, "DUPLICATE_ORIGIN_DOCUMENT");
	}
	return error;
}

async function assertNoDuplicateOrigin(db, type, documentReference, ignoreId = null) {
	if (!documentReference) return;
	const { rows } = await db.query(
		"SELECT case_number FROM cases WHERE type = $1 AND lower(document_reference) = lower($2) AND archived_at IS NULL AND status NOT IN ('Cancelado', 'Improcedente') AND ($3::int IS NULL OR id <> $3)",
		[type, documentReference, ignoreId]
	);
	if (rows[0]) throw conflict(`Ja existe o processo ${rows[0].case_number} deste tipo com o documento de origem "${documentReference}".`, "DUPLICATE_ORIGIN_DOCUMENT");
}

async function resolveRegistry(db, data) {
	let customerId = data.customerId || null;
	let productId = data.productId || null;
	if (customerId) {
		const { rows } = await db.query("SELECT id FROM customers WHERE id = $1 AND active = TRUE", [customerId]);
		if (!rows[0]) throw badRequest("Cliente cadastrado nao encontrado.", "CUSTOMER_NOT_FOUND");
	} else if (data.clientDocument) {
		const { rows } = await db.query("SELECT id FROM customers WHERE document = $1 AND active = TRUE", [data.clientDocument]);
		customerId = rows[0]?.id || null;
	}
	if (productId) {
		const { rows } = await db.query("SELECT id FROM products WHERE id = $1 AND active = TRUE", [productId]);
		if (!rows[0]) throw badRequest("Produto cadastrado nao encontrado.", "PRODUCT_NOT_FOUND");
	} else if (data.productCode) {
		const { rows } = await db.query("SELECT id FROM products WHERE lower(code) = lower($1) AND active = TRUE", [data.productCode]);
		productId = rows[0]?.id || null;
	}
	return { customerId, productId };
}

async function createCase(user, data) {
	if (!can(user, capabilities.CREATE_CASE)) throw forbidden();
	try {
		const created = await withTransaction(async (db) => {
			await assertNoDuplicateOrigin(db, data.type, data.documentReference);
			const { customerId, productId } = await resolveRegistry(db, data);
			const items = data.items || [];
			const summary = items.length
				? { product: items.length > 1 ? `${items[0].description} (+${items.length - 1})` : items[0].description, productCode: items[0].productCode, quantity: items.reduce((sum, entry) => sum + entry.quantity, 0) }
				: { product: data.product, productCode: data.productCode, quantity: data.quantity };
			const caseNumber = await nextCaseNumber(db, data.type);
			const slaDays = await getSlaDays(data.type, db);
			const columns = ["case_number", "type", "status", "responsible", "created_by", "assigned_to", "customer_id", "product_id", "due_at"];
			const values = [caseNumber, data.type, "Criado", user.name, user.id, user.id, customerId, productId, new Date(Date.now() + slaDays * 86400000)];
			const entries = { ...data, ...summary };
			for (const [field, column] of Object.entries(FIELD_COLUMNS)) {
				if (["customerId", "productId", "technicalReport", "technicalOwnerId", "warrantyDestination", "logisticsStatus"].includes(field)) continue;
				if (entries[field] === undefined) continue;
				columns.push(column);
				values.push(entries[field]);
			}
			if (data.type === "Pedido de venda" && items.length && entries.unitPrice === undefined) {
				columns.push("unit_price");
				values.push(items[0].unitPrice ?? null);
			}
			const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
			const { rows } = await db.query(`INSERT INTO cases (${columns.join(", ")}) VALUES (${placeholders}) RETURNING *`, values);
			const inserted = rows[0];
			for (const entry of items) {
				await db.query(
					"INSERT INTO case_items (case_id, product_code, description, quantity, unit_price, serial_number, lot_number) VALUES ($1, $2, $3, $4, $5, $6, $7)",
					[inserted.id, entry.productCode, entry.description, entry.quantity, entry.unitPrice ?? null, entry.serialNumber ?? null, entry.lotNumber ?? null]
				);
			}
			await addEvent(db, inserted.id, "ABERTURA", "Caso criado na triagem", user);
			for (const label of CHECKLIST_TEMPLATES[data.type]) await db.query("INSERT INTO case_checklist_items (case_id, label) VALUES ($1, $2)", [inserted.id, label]);
			return inserted;
		});
		dispatchWebhook("case.created", { id: created.case_number, type: created.type, client: created.client });
		return created;
	} catch (error) {
		throw duplicateOriginError(error, data.documentReference);
	}
}

async function getCaseDetail(user, caseNumber) {
	const item = await findCase(caseNumber, user);
	const [events, items, checklist, attachments] = await Promise.all([
		database.query("SELECT e.id, e.event_type AS type, e.description, e.responsible, e.created_at AS \"createdAt\", e.details, u.name AS \"actorName\" FROM case_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.case_id = $1 ORDER BY e.created_at DESC, e.id DESC", [item.id]),
		database.query("SELECT id, product_code AS \"productCode\", description, quantity, unit_price AS \"unitPrice\", serial_number AS \"serialNumber\", lot_number AS \"lotNumber\" FROM case_items WHERE case_id = $1 ORDER BY id", [item.id]),
		database.query("SELECT id, label, completed, completed_at AS \"completedAt\" FROM case_checklist_items WHERE case_id = $1 ORDER BY id", [item.id]),
		database.query("SELECT a.id, a.file_name AS \"fileName\", a.file_url AS \"fileUrl\", a.mime_type AS \"mimeType\", a.size_bytes AS \"sizeBytes\", a.kind, a.stage, a.created_at AS \"createdAt\", (a.content IS NOT NULL) AS \"hasFile\", u.name AS \"uploadedBy\" FROM case_attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.case_id = $1 AND a.removed_at IS NULL ORDER BY a.created_at DESC", [item.id])
	]);
	const detail = formatCaseDetail(item);
	const { rows: owners } = await database.query("SELECT id, name FROM users WHERE id = ANY($1::int[])", [[item.technical_owner_id, item.assigned_to, item.decided_by].filter(Boolean)]);
	const nameOf = (id) => owners.find((owner) => owner.id === id)?.name || "";
	detail.technicalOwnerName = nameOf(item.technical_owner_id);
	detail.decidedByName = nameOf(item.decided_by);
	const itemRows = items.rows.map((row) => ({ ...row, unitPrice: row.unitPrice === null ? "" : Number(row.unitPrice) }));
	return {
		...detail,
		events: events.rows,
		items: itemRows,
		totalValue: itemRows.length ? itemRows.reduce((sum, row) => sum + row.quantity * (Number(row.unitPrice) || 0), 0) : (Number(item.unit_price) || 0) * (item.quantity || 0),
		checklist: checklist.rows,
		attachments: attachments.rows,
		allowedTransitions: item.archived_at ? [] : allowedTransitions(user, item),
		permissions: {
			edit: can(user, capabilities.EDIT_CASE) && !FINAL_STATUSES.includes(item.status),
			technical: can(user, capabilities.TECHNICAL_ANALYSIS),
			logistics: can(user, capabilities.MANAGE_LOGISTICS),
			assign: can(user, capabilities.ASSIGN_CASES),
			archive: can(user, capabilities.ARCHIVE_CASE)
		}
	};
}

async function listCases(user, query) {
	const { where, values } = buildCaseFilters(user, query);
	const { rows: totals } = await database.query(`SELECT COUNT(*)::int AS total FROM cases c WHERE ${where}`, values);
	const total = totals[0].total;
	const offset = (query.page - 1) * query.pageSize;
	const { rows } = await database.query(
		`SELECT c.* FROM cases c WHERE ${where} ORDER BY ${SORT_COLUMNS[query.sort]} ${query.direction === "asc" ? "ASC" : "DESC"} NULLS LAST, c.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
		[...values, query.pageSize, offset]
	);
	return { cases: rows.map(formatCase), page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) };
}

function diffFields(current, updates) {
	const changes = {};
	for (const [column, next] of Object.entries(updates)) {
		const previous = current[column];
		const normalize = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value === null || value === undefined ? null : String(value));
		if (normalize(previous) !== normalize(next)) changes[column] = { before: previous ?? null, after: next ?? null };
	}
	return changes;
}

async function updateCase(user, caseNumber, data, rawBody) {
	if (!can(user, capabilities.EDIT_CASE)) throw forbidden();
	try {
		return await withTransaction(async (db) => {
			const current = await findCase(caseNumber, user, { db, lock: true, includeArchived: false });
			if (FINAL_STATUSES.includes(current.status)) throw new AppError(422, "Processo encerrado ou cancelado nao pode ser editado. Reabra o processo primeiro.", "CASE_LOCKED");
			const sent = Object.keys(data).concat(Object.keys(rawBody || {}).filter((key) => FIELD_COLUMNS[key] && data[key] === undefined));
			if (sent.some((field) => TECHNICAL_FIELDS.includes(field)) && !can(user, capabilities.TECHNICAL_ANALYSIS)) throw forbidden("Somente tecnico, gerente ou administrador altera laudo e destino.");
			if (sent.some((field) => LOGISTICS_FIELDS.includes(field)) && !can(user, capabilities.MANAGE_LOGISTICS)) throw forbidden("Somente a logistica altera o status de logistica reversa.");
			const updates = {};
			for (const field of new Set(sent)) {
				const column = FIELD_COLUMNS[field];
				if (!column) continue;
				updates[column] = data[field] === undefined ? null : data[field];
			}
			if (data.documentReference !== undefined) await assertNoDuplicateOrigin(db, current.type, data.documentReference, current.id);
			if (data.customerId || data.clientDocument || data.productId || data.productCode) {
				const resolved = await resolveRegistry(db, { customerId: data.customerId, clientDocument: data.clientDocument, productId: data.productId, productCode: data.productCode });
				if (resolved.customerId) updates.customer_id = resolved.customerId;
				if (resolved.productId) updates.product_id = resolved.productId;
			}
			const changes = diffFields(current, updates);
			if (!Object.keys(changes).length) return current;
			const columns = Object.keys(updates);
			const assignments = columns.map((column, index) => `${column} = $${index + 1}`).join(", ");
			const { rows } = await db.query(`UPDATE cases SET ${assignments}, updated_at = NOW() WHERE id = $${columns.length + 1} RETURNING *`, [...columns.map((column) => updates[column]), current.id]);
			await addEvent(db, current.id, "EDICAO", "Dados do processo atualizados", user, { changes });
			return rows[0];
		});
	} catch (error) {
		throw duplicateOriginError(error, data.documentReference);
	}
}

async function changeStatus(user, caseNumber, { status, reason, destination }) {
	const result = await withTransaction(async (db) => {
		const current = await findCase(caseNumber, user, { db, lock: true, includeArchived: false });
		if (current.status === status) throw badRequest("O processo ja possui este status.", "SAME_STATUS");
		// Uma transacao usa um unico client: as consultas rodam em sequencia.
		const { rows: checklist } = await db.query("SELECT completed FROM case_checklist_items WHERE case_id = $1", [current.id]);
		const { rows: attachmentRows } = await db.query("SELECT COUNT(*)::int AS count FROM case_attachments WHERE case_id = $1 AND removed_at IS NULL", [current.id]);
		const requireDocuments = await settings.get("require_documents", true, db);
		const problem = validateTransition(user, current, status, { checklist, attachmentCount: attachmentRows[0].count, requireDocuments, reason, destination });
		if (problem) throw new AppError(problem.code === "FORBIDDEN" ? 403 : 422, problem.message, problem.code);

		const isReopen = FINAL_STATUSES.includes(current.status) && status === REOPEN_TARGET;
		const sets = ["status = $1", "status_reason = $2", "updated_at = NOW()"];
		const values = [status, reason || null];
		const push = (sql, value) => { values.push(value); sets.push(sql.replace("$V", `$${values.length}`)); };

		if (current.status === PAUSING_STATUS && current.sla_paused_at) { sets.push("due_at = due_at + (NOW() - sla_paused_at)", "sla_paused_at = NULL", "sla_notified_at = NULL"); }
		if (status === PAUSING_STATUS) sets.push("sla_paused_at = COALESCE(sla_paused_at, NOW())");
		if (FINISHED_STATUSES.includes(status)) sets.push("closed_at = NOW()");
		if (isReopen) {
			const days = await getSlaDays(current.type, db);
			sets.push("closed_at = NULL", "reopen_count = reopen_count + 1", "sla_paused_at = NULL", "sla_notified_at = NULL");
			push("due_at = NOW() + ($V * INTERVAL '1 day')", days);
			sets.push("warranty_decision = NULL");
		}
		if (status === "Aprovado" || status === "Improcedente") {
			push("decided_by = $V", user.id);
			sets.push("decided_at = NOW()");
			if (current.type === "Garantia") {
				push("warranty_decision = $V", status === "Aprovado" ? "procedente" : "improcedente");
				push("warranty_destination = $V", status === "Improcedente" ? "arquivo" : destination || current.warranty_destination);
			}
		}
		values.push(current.id);
		const { rows } = await db.query(`UPDATE cases SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
		const label = (code) => STATUS_LABELS[code] || code;
		const description = isReopen ? `Processo reaberto (de ${label(current.status)}). Justificativa: ${reason}` : `Status alterado de ${label(current.status)} para ${label(status)}${reason ? `. Motivo: ${reason}` : ""}`;
		await addEvent(db, current.id, isReopen ? "REABERTURA" : "STATUS", description, user, { from: current.status, to: status, reason: reason || null });
		await notifyCaseParticipants(current, user.id, "STATUS_CHANGED", `O processo ${caseNumber} mudou para ${status}.`, db);
		return { updated: rows[0], previous: current.status };
	});
	dispatchWebhook("case.status_changed", { id: caseNumber, previousStatus: result.previous, status });
	return result.updated;
}

async function assignCase(user, caseNumber, assigneeId) {
	if (!can(user, capabilities.ASSIGN_CASES)) throw forbidden();
	const updated = await withTransaction(async (db) => {
		const { rows: assignees } = await db.query("SELECT id, name, role, active FROM users WHERE id = $1", [assigneeId]);
		const assignee = assignees[0];
		if (!assignee || !ASSIGNABLE_ROLES.includes(assignee.role) || !assignee.active) throw badRequest("O processo deve ser atribuido a um usuario ativo de operacao, tecnico ou logistica.", "INVALID_ASSIGNEE");
		const current = await findCase(caseNumber, user, { db, lock: true, includeArchived: false });
		const { rows } = await db.query("UPDATE cases SET assigned_to = $1, responsible = $2, updated_at = NOW() WHERE id = $3 RETURNING *", [assignee.id, assignee.name, current.id]);
		await addEvent(db, current.id, "ATRIBUICAO", `Processo atribuido para ${assignee.name}`, user, { from: current.responsible, to: assignee.name });
		await notifyUser(assignee.id, current.id, "CASE_ASSIGNED", `O processo ${caseNumber} foi atribuido a voce.`, db);
		return rows[0];
	});
	dispatchWebhook("case.assigned", { id: caseNumber, assignedTo: updated.assigned_to, responsible: updated.responsible });
	return updated;
}

async function setArchived(user, caseNumber, archived) {
	if (!can(user, capabilities.ARCHIVE_CASE)) throw forbidden();
	return withTransaction(async (db) => {
		const current = await findCase(caseNumber, user, { db, lock: true });
		if (archived && !FINISHED_STATUSES.includes(current.status)) throw new AppError(422, "Somente processos concluidos, encerrados ou cancelados podem ser arquivados.", "NOT_FINISHED");
		const { rows } = await db.query(`UPDATE cases SET archived_at = ${archived ? "NOW()" : "NULL"}, updated_at = NOW() WHERE id = $1 RETURNING *`, [current.id]);
		await addEvent(db, current.id, archived ? "ARQUIVAMENTO" : "DESARQUIVAMENTO", archived ? "Processo arquivado" : "Processo restaurado do arquivo", user);
		return rows[0];
	});
}

module.exports = {
	FIELD_COLUMNS, ASSIGNABLE_ROLES, formatCase, formatCaseDetail, formatDate, nextCaseNumber, addEvent, canView, findCase,
	createCase, getCaseDetail, listCases, updateCase, changeStatus, assignCase, setArchived
};
