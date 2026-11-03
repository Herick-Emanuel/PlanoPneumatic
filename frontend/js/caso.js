const sharedShellScript = document.createElement("script");
sharedShellScript.src = "/js/shared-shell.js";
document.head.appendChild(sharedShellScript);

(async () => {
	const PP = window.PP;
	const { esc, api } = PP;
	const root = document.querySelector("#case-root");
	const caseId = new URLSearchParams(window.location.search).get("id");
	let me = null;
	let meta = null;
	let settings = { require_documents: true };
	let data = null;
	let assignees = [];

	const TYPE_FIELDS = {
		"Pedido de venda": [["salesRepresentative", "Vendedor"], ["unitPrice", "Valor unitário", "money"], ["paymentTerms", "Condição de pagamento"], ["salesChannel", "Canal de venda"]],
		"Base de troca": [["exchangeReason", "Motivo da troca", "exchangeReasons"], ["itemCondition", "Condição do item", "itemConditions"], ["originOrder", "Pedido de origem"], ["trackingCode", "Rastreio de retorno"]],
		Garantia: [["receivedAt", "Data de recebimento", "date"], ["defectDescription", "Defeito relatado", "textarea"], ["riskLevel", "Nível de risco", "riskLevels"]]
	};
	const COMMON_FIELDS = [["client", "Cliente"], ["clientDocument", "CPF/CNPJ", "document"], ["product", "Produto"], ["productCode", "Código"], ["quantity", "Quantidade", "number"], ["documentReference", "Documento de origem"], ["serialNumber", "Nº de série"], ["lotNumber", "Lote"], ["notes", "Observações", "textarea"]];
	const MAIN_PATH = { "Pedido de venda": ["Criado", "Em analise", "Aprovado", "Em faturamento", "Concluido", "Encerrado"], "Base de troca": ["Criado", "Em analise", "Aprovado", "Processando", "Concluido", "Encerrado"], Garantia: ["Criado", "Em analise", "Aprovado", "Processando", "Concluido", "Encerrado"] };
	const EVENT_LABELS = { ABERTURA: "Abertura", STATUS: "Status", EDICAO: "Edição", ATRIBUICAO: "Atribuição", COMENTARIO: "Comentário", ANEXO: "Anexo", CHECKLIST: "Checklist", REABERTURA: "Reabertura", ARQUIVAMENTO: "Arquivamento", DIVERGENCIA: "Divergência", VALIDACAO: "Validação Omie", DESARQUIVAMENTO: "Restauração" };
	const COLUMN_LABELS = { client: "Cliente", client_document: "Documento", product: "Produto", product_code: "Código", quantity: "Quantidade", document_reference: "Documento de origem", notes: "Observações", sales_representative: "Vendedor", unit_price: "Valor unitário", payment_terms: "Pagamento", sales_channel: "Canal", exchange_reason: "Motivo da troca", item_condition: "Condição", origin_order: "Pedido de origem", tracking_code: "Rastreio", received_at: "Recebimento", defect_description: "Defeito", risk_level: "Risco", serial_number: "Série", lot_number: "Lote", technical_report: "Laudo", technical_owner_id: "Responsável técnico", warranty_destination: "Destino", logistics_status: "Logística" };

	function options(list, selected, placeholder = "—") {
		const values = Array.isArray(list) ? list : Object.keys(list);
		const label = (value) => (Array.isArray(list) ? value : list[value]);
		return `<option value="">${placeholder}</option>${values.map((value) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label(value))}</option>`).join("")}`;
	}
	const display = (value, kind) => {
		if (value === "" || value === null || value === undefined) return "—";
		if (kind === "money") return PP.money(value);
		if (kind === "document") return PP.formatDocument(value);
		if (kind === "date") return new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR");
		return value;
	};

	function missingForNext() {
		// Resume o que falta para avancar ao proximo passo do fluxo (fluxo guiado).
		const hints = [];
		const pending = data.checklist.filter((entry) => !entry.completed).length;
		const path = MAIN_PATH[data.type];
		const index = path.indexOf(data.status);
		const next = index >= 0 ? path[index + 1] : null;
		if (data.status === "Aguardando documento") hints.push("Anexe o documento solicitado e volte o processo para análise.");
		if (!next) return hints;
		if (data.type === "Garantia" && next === "Aprovado") {
			if (!data.technicalReport) hints.push("Registrar o laudo técnico.");
		}
		if (data.type === "Base de troca" && next === "Aprovado") {
			if (!data.exchangeReason) hints.push("Informar o motivo da troca.");
			if (!data.itemCondition) hints.push("Avaliar a condição do item.");
		}
		if (["Concluido", "Encerrado"].includes(next) || (data.status === "Em faturamento" || data.status === "Processando")) {
			if (pending) hints.push(`Concluir o checklist (${pending} pendente${pending > 1 ? "s" : ""}).`);
			if (settings.require_documents && !data.attachments.length) hints.push("Anexar ao menos um documento.");
		}
		return hints;
	}

	const DIVERGENCE_TEXT = { quantidade: (i) => `quantidade ${i.local} (Omie: ${i.omie})`, preco: (i) => `preço ${PP.money(i.local)} (Omie: ${PP.money(i.omie)})`, item_fora_do_pedido: () => "item que não consta no pedido do Omie", item_ausente: (i) => `item do Omie ausente aqui (qtd ${i.omie.quantity})` };
	function divergenceBanner() {
		const issues = data.commercialDivergence?.issues;
		if (!issues?.length) return data.omieOrderNumber ? `<p class="muted" style="margin-top:12px">✔ Itens conferem com o pedido ${esc(data.omieOrderNumber)} do Omie.</p>` : "";
		return `<div class="draft-banner" role="alert" style="margin-top:12px"><span><strong>Divergência comercial com o pedido ${esc(data.omieOrderNumber)} do Omie — revisão do gerente necessária antes de aprovar:</strong><ul style="margin:6px 0 0">${issues.map((issue) => `<li><strong>${esc(issue.code)}</strong>: ${esc((DIVERGENCE_TEXT[issue.kind] || (() => issue.kind))(issue))}</li>`).join("")}</ul></span></div>`;
	}

	function render() {
		const permissions = data.permissions;
		document.querySelector("#case-title").textContent = data.id;
		document.title = `Plano Pneumatic | ${data.id}`;
		const path = MAIN_PATH[data.type];
		const currentIndex = path.indexOf(data.status);
		const stepper = path.map((status, index) => `<li class="${index < currentIndex ? "done" : status === data.status ? "current" : ""}" ${status === data.status ? 'aria-current="step"' : ""}>${esc(PP.statusLabel(status))}</li>`).join("");
		const finalNote = currentIndex < 0 ? `<li class="current">${esc(PP.statusLabel(data.status))}</li>` : "";
		const hints = missingForNext();
		const fields = [...COMMON_FIELDS, ...TYPE_FIELDS[data.type]];
		const details = fields.map(([key, label, kind]) => `<div><small>${esc(label)}</small><strong>${esc(display(data[key], kind === "document" ? "document" : kind === "money" ? "money" : kind === "date" ? "date" : undefined))}</strong></div>`).join("");
		const transitionButtons = data.allowedTransitions.map((status) => {
			const reopen = ["Encerrado", "Cancelado"].includes(data.status) && status === "Em analise";
			return `<button class="button ${status === "Cancelado" || status === "Improcedente" ? "button-secondary" : "button-primary"} compact-button" type="button" data-transition="${esc(status)}">${reopen ? "Reabrir processo" : esc(PP.statusLabel(status))}</button>`;
		}).join("") || '<span class="muted">Nenhuma ação disponível para o seu perfil neste status.</span>';
		const itemsPanel = data.items.length ? `<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Pedido</p><h2>Itens e valores</h2></div><strong>${esc(PP.money(data.totalValue))}</strong></div><div class="table-wrap"><table><thead><tr><th>Código</th><th>Descrição</th><th>Qtd</th><th>Unitário</th><th>Subtotal</th></tr></thead><tbody>${data.items.map((item) => `<tr><td>${esc(item.productCode)}</td><td>${esc(item.description)}</td><td>${esc(item.quantity)}</td><td>${esc(PP.money(item.unitPrice))}</td><td>${esc(PP.money(item.quantity * (Number(item.unitPrice) || 0)))}</td></tr>`).join("")}</tbody></table></div></article>` : "";
		const reportPanel = data.type === "Garantia" ? `<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Análise técnica</p><h2>Laudo e decisão</h2></div>${data.warrantyDecision ? `<span class="table-status ${data.warrantyDecision === "procedente" ? "green" : "red"}">${data.warrantyDecision === "procedente" ? "Procedente" : "Improcedente"}</span>` : '<span class="table-status orange">Sem decisão</span>'}</div><div class="kv-grid"><div><small>Responsável técnico</small><strong>${esc(data.technicalOwnerName || "—")}</strong></div><div><small>Destino</small><strong>${esc(meta.warrantyDestinations[data.warrantyDestination] || "—")}</strong></div><div><small>Decidido por</small><strong>${esc(data.decidedByName || "—")}</strong></div></div>${permissions.technical && permissions.edit ? `<form id="report-form" class="form"><label>Laudo técnico<textarea name="technicalReport" rows="5" maxlength="8000" placeholder="Descreva a análise, a causa do defeito e a conclusão">${esc(data.technicalReport)}</textarea></label><div class="form-actions"><button class="button button-secondary compact-button" type="button" id="take-ownership">Assumir como responsável técnico</button><button class="button button-primary compact-button" type="submit">Salvar laudo</button></div></form>` : `<p style="white-space:pre-wrap">${esc(data.technicalReport || "Nenhum laudo registrado.")}</p>`}</article>` : "";
		const logisticsPanel = data.type === "Base de troca" ? `<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Logística reversa</p><h2>Retorno do item</h2></div><span class="table-status blue">${esc(data.logisticsStatus || "Sem status")}</span></div>${permissions.logistics && permissions.edit ? `<form id="logistics-form" class="inline-form"><label>Rastreio<input name="trackingCode" value="${esc(data.trackingCode)}" maxlength="80" /></label><label>Status<select name="logisticsStatus">${options(meta.logisticsStatuses, data.logisticsStatus)}</select></label><button class="button button-primary compact-button" type="submit">Salvar</button></form>` : `<p class="muted">Rastreio: ${esc(data.trackingCode || "—")}</p>`}</article>` : "";
		const assigneePanel = permissions.assign && !data.archived ? `<label>Responsável<select id="assignee-select">${assignees.map((user) => `<option value="${esc(user.id)}" ${user.id === data.assignedTo ? "selected" : ""}>${esc(user.name)} (${esc(PP.roleLabel(user.role))})</option>`).join("")}${assignees.some((user) => user.id === data.assignedTo) ? "" : `<option value="" selected>${esc(data.responsible)}</option>`}</select></label>` : `<p><small class="muted">Responsável</small><br><strong>${esc(data.responsible)}</strong></p>`;
		const kinds = meta.attachmentKinds.filter((kind) => kind !== "laudo" || permissions.technical);
		const attachments = data.attachments.map((item) => `<div class="attachment-row"><div><strong>${esc(item.fileName)}</strong><small>${esc(item.kind)}${item.stage ? ` · ${esc(PP.statusLabel(item.stage))}` : ""}${item.sizeBytes ? ` · ${esc(PP.fileSize(item.sizeBytes))}` : ""} · ${esc(item.uploadedBy || "")} ${esc(PP.formatDateTime(item.createdAt))}</small></div><div class="actions-cell">${item.hasFile ? `<button class="button button-secondary compact-button" type="button" data-open-attachment="${esc(item.id)}">Abrir</button>` : /^https:\/\//i.test(item.fileUrl || "") ? `<a class="button button-secondary compact-button" href="${esc(item.fileUrl)}" target="_blank" rel="noopener noreferrer">Link</a>` : ""}${permissions.edit ? `<button class="button button-secondary compact-button" type="button" data-remove-attachment="${esc(item.id)}" aria-label="Remover ${esc(item.fileName)}">Remover</button>` : ""}</div></div>`).join("") || PP.emptyState("Nenhum documento anexado", "Anexe fotos, laudos ou comprovantes.");
		const timeline = data.events.map((event) => {
			const changes = event.details?.changes ? `<details><summary>Ver alterações</summary><ul>${Object.entries(event.details.changes).map(([column, change]) => `<li><strong>${esc(COLUMN_LABELS[column] || column)}:</strong> ${esc(change.before ?? "—")} → ${esc(change.after ?? "—")}</li>`).join("")}</ul></details>` : "";
			return `<div class="timeline-entry"><strong>${esc(EVENT_LABELS[event.type] || event.type)} · ${esc(event.description)}</strong><small>${esc(event.actorName || event.responsible)} · ${esc(PP.formatDateTime(event.createdAt))}</small>${changes}</div>`;
		}).join("");

		root.innerHTML = `
			<section class="panel">
				<div class="case-header">
					<div><h2 style="margin:0">${esc(data.client)}</h2><p class="muted" style="margin:4px 0 0">${esc(data.type)} · ${esc(data.product)} (${esc(data.productCode)}) × ${esc(data.quantity)}</p></div>
					<div class="case-badges"><span class="table-status ${PP.statusTone(data.status)}">${esc(PP.statusLabel(data.status))}</span>${PP.slaBadge(data)}${data.riskLevel ? `<span class="table-status ${data.riskLevel === "Alto" ? "red" : data.riskLevel === "Atenção" ? "orange" : "blue"}">Risco: ${esc(data.riskLevel)}</span>` : ""}${data.archived ? '<span class="table-status blue">Arquivado</span>' : ""}${data.reopenCount ? `<span class="table-status orange">Reaberto ${esc(data.reopenCount)}×</span>` : ""}</div>
				</div>
				<ol class="stepper" aria-label="Etapas do processo">${stepper}${finalNote}</ol>
				${data.statusReason ? `<p class="muted"><strong>Motivo registrado:</strong> ${esc(data.statusReason)}</p>` : ""}
				<div class="transition-bar" role="group" aria-label="Ações permitidas">${transitionButtons}${permissions.archive && (data.archived || ["Concluido", "Encerrado", "Cancelado"].includes(data.status)) ? `<button class="button button-secondary compact-button" type="button" data-archive="${data.archived ? "off" : "on"}">${data.archived ? "Restaurar do arquivo" : "Arquivar"}</button>` : ""}</div>
				${divergenceBanner()}
				${hints.length ? `<div class="draft-banner" style="margin-top:12px"><span><strong>O que falta para avançar:</strong> ${hints.map(esc).join(" ")}</span></div>` : ""}
			</section>
			<div class="case-grid" style="margin-top:16px">
				<section>
					<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Dados</p><h2>Informações do processo</h2></div>${permissions.edit && !data.archived ? '<button class="button button-secondary compact-button" type="button" id="edit-case">Editar dados</button>' : ""}</div><div class="kv-grid">${details}</div></article>
					${itemsPanel}${reportPanel}${logisticsPanel}
					<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Interno</p><h2>Comentários</h2></div></div>${permissions.edit ? '<form id="comment-form" class="form"><label class="sr-only" for="comment-body">Comentário</label><textarea id="comment-body" name="body" rows="3" maxlength="4000" placeholder="Adicione um comentário interno…" required></textarea><div class="form-actions"><button class="button button-primary compact-button" type="submit">Comentar</button></div></form>' : ""}<div id="comment-list">${PP.skeleton(2)}</div></article>
				</section>
				<section>
					<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Responsabilidade</p><h2>Atribuição e prazo</h2></div></div>${assigneePanel}<p style="margin-bottom:0"><small class="muted">Prazo</small><br><strong>${data.dueAt ? esc(PP.formatDateTime(data.dueAt)) : "—"}</strong> ${PP.slaBadge(data)}</p></article>
					<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Etapas</p><h2>Checklist</h2></div><span class="muted">${data.checklist.filter((entry) => entry.completed).length}/${data.checklist.length}</span></div><div class="checklist">${data.checklist.map((entry) => `<label><input type="checkbox" data-checklist="${esc(entry.id)}" ${entry.completed ? "checked" : ""} ${permissions.edit ? "" : "disabled"} /> ${esc(entry.label)}</label>`).join("") || '<p class="muted">Sem checklist.</p>'}</div></article>
					<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Documentos</p><h2>Anexos</h2></div></div>${permissions.edit && !data.archived ? `<div class="dropzone" id="dropzone"><span>Arraste um arquivo (JPG, PNG, WEBP ou PDF, até 10 MB) ou</span><div class="inline-form" style="justify-content:center"><label>Tipo<select id="attachment-kind">${kinds.map((kind) => `<option>${esc(kind)}</option>`).join("")}</select></label><label>Arquivo<input type="file" id="attachment-file" accept="image/jpeg,image/png,image/webp,application/pdf" /></label></div><span id="upload-status" class="muted" role="status"></span></div>` : ""}<div>${attachments}</div></article>
					<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Rastreabilidade</p><h2>Linha do tempo</h2></div></div><div class="timeline">${timeline}</div></article>${data.serialNumber || data.lotNumber ? `<p><a class="table-link" href="/historico.html?serial=${encodeURIComponent(data.serialNumber || data.lotNumber)}">Ver histórico desta peça (série/lote) →</a></p>` : ""}
				</section>
			</div>`;
		bind();
		loadComments();
	}

	async function loadComments() {
		const list = document.querySelector("#comment-list");
		if (!list) return;
		try {
			const result = await api.get(`/api/cases/${encodeURIComponent(caseId)}/comments`);
			list.innerHTML = result.comments.map((item) => `<div class="comment-item"><strong>${esc(item.authorName)}</strong> <small class="muted">${esc(PP.formatDateTime(item.createdAt))}</small><p style="white-space:pre-wrap;margin:4px 0 10px">${esc(item.body)}</p></div>`).join("") || PP.emptyState("Nenhum comentário ainda");
		} catch (error) { list.innerHTML = `<p class="feedback">${esc(error.message)}</p>`; }
	}

	async function reload(keepScroll = true) {
		const scroll = window.scrollY;
		data = (await api.get(`/api/cases/${encodeURIComponent(caseId)}`)).case;
		render();
		if (keepScroll) window.scrollTo(0, scroll);
	}

	async function runTransition(status) {
		const reopen = ["Encerrado", "Cancelado"].includes(data.status) && status === "Em analise";
		const needsReason = ["Cancelado", "Improcedente"].includes(status) || reopen;
		const isApprove = data.type === "Garantia" && status === "Aprovado";
		const title = reopen ? "Reabrir processo" : `Mover para "${PP.statusLabel(status)}"`;
		let body = `<p>${reopen ? "Informe a justificativa da reabertura." : `O processo <strong>${esc(data.id)}</strong> passará de <strong>${esc(PP.statusLabel(data.status))}</strong> para <strong>${esc(PP.statusLabel(status))}</strong>.`}</p>`;
		if (isApprove) body += `<label>Destino da garantia *<select name="destination" required>${options(meta.warrantyDestinations, data.warrantyDestination, "Selecione")}</select></label>`;
		if (needsReason) body += `<label>${reopen ? "Justificativa" : "Motivo"} *<textarea name="reason" rows="3" maxlength="2000" required></textarea></label>`;
		else body += '<label>Observação (opcional)<textarea name="reason" rows="2" maxlength="2000"></textarea></label>';
		const answer = await PP.dialog({ title, body, confirmLabel: reopen ? "Reabrir" : "Confirmar", danger: ["Cancelado", "Improcedente"].includes(status) });
		if (!answer) return;
		const previous = data.status;
		try {
			await api.patch(`/api/cases/${encodeURIComponent(caseId)}/status`, { status, reason: answer.reason || undefined, destination: answer.destination || undefined });
			await reload();
			const canUndo = !reopen && !["Aprovado", "Improcedente", "Encerrado", "Cancelado", "Concluido"].includes(status) && (meta.transitions[data.type][status] || []).includes(previous);
			PP.toast(`Status alterado para ${PP.statusLabel(status)}.`, "success", canUndo ? "Desfazer" : undefined, canUndo ? async () => {
				try { await api.patch(`/api/cases/${encodeURIComponent(caseId)}/status`, { status: previous }); await reload(); PP.toast("Alteração desfeita."); } catch (error) { PP.toast(error.message, "error"); }
			} : undefined);
		} catch (error) { PP.toast(error.message, "error"); }
	}

	function editFieldHtml([key, label, kind]) {
		const value = data[key] ?? "";
		if (kind === "textarea") return `<label class="wide-field">${esc(label)}<textarea name="${key}" rows="3">${esc(value)}</textarea></label>`;
		if (["exchangeReasons", "itemConditions", "riskLevels"].includes(kind)) return `<label>${esc(label)}<select name="${key}">${options(meta[kind], value)}</select></label>`;
		const type = kind === "number" ? "number" : kind === "date" ? "date" : "text";
		const shown = kind === "document" ? PP.formatDocument(value) : kind === "money" && value !== "" ? Number(value).toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : value;
		return `<label>${esc(label)}<input name="${key}" type="${type}" value="${esc(shown)}" ${kind === "number" ? 'min="1"' : ""} ${["client", "product", "productCode", "quantity"].includes(key) ? "required" : ""} /></label>`;
	}

	async function openEditor() {
		const fields = [...COMMON_FIELDS, ...TYPE_FIELDS[data.type]];
		const modal = document.createElement("div");
		modal.className = "modal";
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("aria-label", "Editar processo");
		modal.innerHTML = `<div class="modal-card editor-card"><div class="panel-heading"><div><p class="eyebrow">Editar processo</p><h2>${esc(data.id)}</h2></div><button class="close-button" type="button" data-close aria-label="Fechar">&times;</button></div><form class="form editor-form" novalidate><div class="editor-grid">${fields.map(editFieldHtml).join("")}</div><p class="feedback" role="alert"></p><div class="form-actions"><button class="button button-secondary" type="button" data-close>Cancelar</button><button class="button button-primary" type="submit">Salvar alterações</button></div></form></div>`;
		document.body.appendChild(modal);
		const form = modal.querySelector("form");
		const close = () => { modal.remove(); document.removeEventListener("keydown", onKey); };
		const onKey = (event) => { if (event.key === "Escape") close(); };
		document.addEventListener("keydown", onKey);
		modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
		if (form.elements.clientDocument) PP.bindDocumentInput(form.elements.clientDocument);
		if (form.elements.unitPrice) PP.bindMoneyInput(form.elements.unitPrice);
		form.elements[fields[0][0]].focus();
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			PP.clearFieldErrors(form);
			const payload = {};
			for (const [key, , kind] of fields) {
				let value = form.elements[key].value;
				if (kind === "number") value = Number(value);
				else if (kind === "money") value = value === "" ? "" : PP.parseMoney(value);
				payload[key] = Number.isNaN(value) ? "" : value;
			}
			try { await api.patch(`/api/cases/${encodeURIComponent(caseId)}`, payload); close(); await reload(); PP.toast("Dados atualizados.", "success"); }
			catch (error) { if (!PP.applyServerErrors(form, error)) form.querySelector(".feedback").textContent = error.message; }
		});
	}

	async function uploadFile(file) {
		const status = document.querySelector("#upload-status");
		if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) { status.textContent = "Tipo não permitido. Envie JPG, PNG, WEBP ou PDF."; return; }
		if (file.size > 10 * 1024 * 1024) { status.textContent = "O arquivo excede 10 MB."; return; }
		status.textContent = `Enviando ${file.name}…`;
		const kind = document.querySelector("#attachment-kind").value;
		try {
			await api(`/api/cases/${encodeURIComponent(caseId)}/attachments/upload?kind=${encodeURIComponent(kind)}&stage=${encodeURIComponent(data.status)}`, { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) } });
			await reload();
			PP.toast("Anexo enviado.", "success");
		} catch (error) { status.textContent = error.message; }
	}

	function bind() {
		root.querySelectorAll("[data-transition]").forEach((button) => button.addEventListener("click", () => runTransition(button.dataset.transition)));
		root.querySelector("#edit-case")?.addEventListener("click", openEditor);
		root.querySelector("[data-archive]")?.addEventListener("click", async (event) => {
			const archive = event.currentTarget.dataset.archive === "on";
			try { await api.post(`/api/cases/${encodeURIComponent(caseId)}/${archive ? "archive" : "unarchive"}`); await reload(); PP.toast(archive ? "Processo arquivado." : "Processo restaurado.", "success"); } catch (error) { PP.toast(error.message, "error"); }
		});
		root.querySelector("#assignee-select")?.addEventListener("change", async (event) => {
			if (!event.target.value) return;
			try { await api.patch(`/api/cases/${encodeURIComponent(caseId)}/assignee`, { assignedTo: Number(event.target.value) }); await reload(); PP.toast("Responsável atualizado.", "success"); } catch (error) { PP.toast(error.message, "error"); await reload(); }
		});
		root.querySelectorAll("[data-checklist]").forEach((input) => input.addEventListener("change", async () => {
			try { await api.patch(`/api/cases/${encodeURIComponent(caseId)}/checklist/${input.dataset.checklist}`, { completed: input.checked }); await reload(); } catch (error) { input.checked = !input.checked; PP.toast(error.message, "error"); }
		}));
		root.querySelector("#comment-form")?.addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = event.currentTarget;
			try { await api.post(`/api/cases/${encodeURIComponent(caseId)}/comments`, { body: form.body.value }); form.reset(); await loadComments(); } catch (error) { PP.toast(error.message, "error"); }
		});
		root.querySelector("#report-form")?.addEventListener("submit", async (event) => {
			event.preventDefault();
			try { await api.patch(`/api/cases/${encodeURIComponent(caseId)}`, { technicalReport: event.currentTarget.technicalReport.value }); await reload(); PP.toast("Laudo salvo.", "success"); } catch (error) { PP.toast(error.message, "error"); }
		});
		root.querySelector("#take-ownership")?.addEventListener("click", async () => {
			try { await api.patch(`/api/cases/${encodeURIComponent(caseId)}`, { technicalOwnerId: me.id }); await reload(); PP.toast("Você é o responsável técnico.", "success"); } catch (error) { PP.toast(error.message, "error"); }
		});
		root.querySelector("#logistics-form")?.addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = event.currentTarget;
			try { await api.patch(`/api/cases/${encodeURIComponent(caseId)}`, { trackingCode: form.trackingCode.value, logisticsStatus: form.logisticsStatus.value }); await reload(); PP.toast("Logística atualizada.", "success"); } catch (error) { PP.toast(error.message, "error"); }
		});
		root.querySelectorAll("[data-open-attachment]").forEach((button) => button.addEventListener("click", () => PP.openFile(`/api/cases/${encodeURIComponent(caseId)}/attachments/${button.dataset.openAttachment}/file`).catch((error) => PP.toast(error.message, "error"))));
		root.querySelectorAll("[data-remove-attachment]").forEach((button) => button.addEventListener("click", async () => {
			if (!(await PP.confirmAction("Remover anexo", "O anexo será removido da lista do processo. Deseja continuar?", "Remover", true))) return;
			try { await api.delete(`/api/cases/${encodeURIComponent(caseId)}/attachments/${button.dataset.removeAttachment}`); await reload(); } catch (error) { PP.toast(error.message, "error"); }
		}));
		const zone = root.querySelector("#dropzone");
		if (zone) {
			root.querySelector("#attachment-file").addEventListener("change", (event) => { if (event.target.files[0]) uploadFile(event.target.files[0]); });
			["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add("dragover"); }));
			["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove("dragover"); }));
			zone.addEventListener("drop", (event) => { if (event.dataTransfer.files[0]) uploadFile(event.dataTransfer.files[0]); });
		}
	}

	try {
		if (!caseId) { root.innerHTML = PP.emptyState("Nenhum processo selecionado", "Abra um processo pelo histórico ou pela busca (Ctrl+K)."); return; }
		root.innerHTML = PP.skeleton(6);
		me = await PP.requireUser();
		if (!me) return;
		PP.fillProfile(me);
		PP.bindLogout();
		[meta, settings] = await Promise.all([PP.meta(), api.get("/api/settings").then((result) => result.settings).catch(() => settings)]);
		data = (await api.get(`/api/cases/${encodeURIComponent(caseId)}`)).case;
		if (data.permissions.assign) assignees = (await api.get("/api/users/assignable").catch(() => ({ users: [] }))).users;
		render();
		window.PPShellTools?.mount();
		// Recem-criado: a conferencia com o Omie roda em segundo plano; atualiza ate aparecer o resultado.
		if (new URLSearchParams(window.location.search).get("created") && data.type === "Pedido de venda" && data.documentReference) {
			let tries = 0;
			const timer = setInterval(async () => {
				tries += 1;
				if (tries > 20 || data.events.some((event) => ["VALIDACAO", "DIVERGENCIA"].includes(event.type))) return clearInterval(timer);
				try { await reload(); } catch { clearInterval(timer); }
			}, 5000);
		}
	} catch (error) {
		root.innerHTML = PP.errorState(error.status === 404 ? "Processo não encontrado ou sem permissão de acesso." : error.message);
		root.querySelector("[data-retry]")?.addEventListener("click", () => window.location.reload());
	}
})();
