const sharedShellScript = document.createElement("script");
sharedShellScript.src = "/js/shared-shell.js";
document.head.appendChild(sharedShellScript);

(async () => {
	const PP = window.PP;
	const { esc, api } = PP;
	const page = document.querySelector("[data-process-type]");
	const processType = page.dataset.processType;
	const form = document.querySelector("#process-form");
	const feedback = document.querySelector("#process-feedback");
	const draftKey = `pp-draft:${processType}`;

	const config = {
		"Pedido de venda": { title: "Novo pedido de venda", eyebrow: "Etapa 2 · Comercial", description: "Valide os dados comerciais antes de encaminhar para faturamento ou operação.", submit: "Salvar pedido", fields: ["documentReference", "salesRepresentative", "unitPrice", "paymentTerms", "salesChannel", "serialNumber", "lotNumber"] },
		"Base de troca": { title: "Nova base de troca", eyebrow: "Etapa 2 · Operação", description: "Registre a origem, condição e justificativa do item que será trocado.", submit: "Salvar troca", fields: ["exchangeReason", "itemCondition", "documentReference", "originOrder", "trackingCode", "serialNumber", "lotNumber"] },
		Garantia: { title: "Nova garantia", eyebrow: "Etapa 2 · Técnico", description: "Registre o recebimento da peça e encaminhe o caso para análise técnica.", submit: "Salvar garantia", fields: ["receivedAt", "documentReference", "defectDescription", "riskLevel", "serialNumber", "lotNumber"] }
	}[processType];

	const text = (name, label, placeholder = "", extra = "") => `<label>${label}<input name="${name}" type="text" placeholder="${placeholder}" ${extra} /></label>`;
	const select = (name, label, values, required) => `<label>${label}${required ? " *" : ""}<select name="${name}" ${required ? "required" : ""}><option value="">Selecione</option>${values.map((value) => `<option>${esc(value)}</option>`).join("")}</select></label>`;
	let meta;
	const fieldHtml = {
		documentReference: () => text("documentReference", processType === "Garantia" ? "Documento de entrada" : "Documento de origem", "Nota fiscal ou pedido"),
		salesRepresentative: () => text("salesRepresentative", "Vendedor responsável", "Nome do vendedor"),
		unitPrice: () => `<label>Valor unitário<input name="unitPrice" type="text" inputmode="decimal" placeholder="0,00" /></label>`,
		paymentTerms: () => text("paymentTerms", "Condição de pagamento", "Ex.: 28 dias"),
		salesChannel: () => text("salesChannel", "Canal de venda", "Ex.: Comercial"),
		exchangeReason: () => select("exchangeReason", "Motivo da troca", meta.exchangeReasons, true),
		itemCondition: () => select("itemCondition", "Condição do item", meta.itemConditions, true),
		originOrder: () => text("originOrder", "Pedido de origem", "Número do pedido"),
		trackingCode: () => text("trackingCode", "Código de rastreio", "Código de retorno"),
		receivedAt: () => `<label>Data de recebimento<input name="receivedAt" type="date" max="${new Date().toISOString().slice(0, 10)}" /></label>`,
		defectDescription: () => `<label class="wide-field">Defeito ou motivo relatado<textarea name="defectDescription" rows="3" placeholder="Descreva o problema informado"></textarea></label>`,
		riskLevel: () => `<label>Nível de risco<select name="riskLevel"><option value="">Normal</option>${meta.riskLevels.filter((level) => level !== "Normal").map((level) => `<option>${esc(level)}</option>`).join("")}</select></label>`,
		serialNumber: () => text("serialNumber", "Nº de série", "Opcional"),
		lotNumber: () => text("lotNumber", "Lote", "Opcional")
	};

	// ---- Itens adicionais do pedido (F6) -------------------------------------------
	function addItemsBlock() {
		if (processType !== "Pedido de venda") return;
		const section = document.createElement("section");
		section.className = "triage-section";
		section.innerHTML = '<div class="section-heading"><div><p class="eyebrow">02b · Itens adicionais</p><h2>Outros produtos do pedido</h2></div><button class="button button-secondary compact-button" type="button" id="add-item">+ Adicionar item</button></div><table class="items-table" aria-label="Itens adicionais do pedido"><thead><tr><th>Código</th><th>Descrição</th><th>Qtd</th><th>Unitário (R$)</th><th><span class="sr-only">Remover</span></th></tr></thead><tbody id="items-body"></tbody></table><p class="items-total" id="items-total" aria-live="polite"></p>';
		document.querySelector("#special-fields").closest("section").after(section);
		const body = section.querySelector("#items-body");
		const addRow = (values = {}) => {
			const row = document.createElement("tr");
			row.innerHTML = `<td><input data-item="productCode" aria-label="Código do item" value="${esc(values.productCode || "")}" /></td><td><input data-item="description" aria-label="Descrição do item" value="${esc(values.description || "")}" /></td><td><input data-item="quantity" type="number" min="1" aria-label="Quantidade do item" value="${esc(values.quantity || 1)}" /></td><td><input data-item="unitPrice" inputmode="decimal" aria-label="Valor unitário do item" value="${esc(values.unitPrice ?? "")}" /></td><td><button type="button" class="close-button" aria-label="Remover item">&times;</button></td>`;
			row.querySelector("button").addEventListener("click", () => { row.remove(); updateTotal(); saveDraftSoon(); });
			PP.bindMoneyInput(row.querySelector('[data-item="unitPrice"]'));
			body.appendChild(row);
		};
		section.querySelector("#add-item").addEventListener("click", () => { addRow(); body.lastElementChild.querySelector("input").focus(); });
		body.addEventListener("input", updateTotal);
		window.__addItemRow = addRow;
	}
	function readItems() {
		return [...document.querySelectorAll("#items-body tr")].map((row) => {
			const value = (name) => row.querySelector(`[data-item="${name}"]`).value;
			const price = PP.parseMoney(value("unitPrice"));
			return { productCode: value("productCode").trim(), description: value("description").trim(), quantity: Number(value("quantity")), ...(Number.isFinite(price) ? { unitPrice: price } : {}) };
		}).filter((item) => item.productCode || item.description);
	}
	function updateTotal() {
		const total = document.querySelector("#items-total");
		if (!total) return;
		const main = Number(form.quantity.value || 0) * (PP.parseMoney(form.unitPrice?.value) || 0);
		const extra = readItems().reduce((sum, item) => sum + item.quantity * (item.unitPrice || 0), 0);
		total.textContent = `Total do pedido: ${PP.money(main + extra)}`;
	}

	// ---- Autopreenchimento a partir do cadastro (F3 / usabilidade) -----------------
	function bindRegistry() {
		const customerList = Object.assign(document.createElement("datalist"), { id: "customer-options" });
		const productList = Object.assign(document.createElement("datalist"), { id: "product-options" });
		document.body.append(customerList, productList);
		let customers = [];
		let products = [];
		form.client.setAttribute("list", "customer-options");
		form.client.setAttribute("autocomplete", "off");
		form.productCode.setAttribute("list", "product-options");
		form.productCode.setAttribute("autocomplete", "off");
		const searchCustomers = PP.debounce(async () => {
			if (form.client.value.trim().length < 2) return;
			try { customers = (await api.get(`/api/customers?q=${encodeURIComponent(form.client.value.trim())}&limit=8`)).customers; customerList.innerHTML = customers.map((customer) => `<option value="${esc(customer.name)}">${esc(PP.formatDocument(customer.document || ""))}</option>`).join(""); } catch { /* autocomplete e opcional */ }
		});
		const searchProducts = PP.debounce(async () => {
			if (form.productCode.value.trim().length < 2) return;
			try { products = (await api.get(`/api/products?q=${encodeURIComponent(form.productCode.value.trim())}&limit=8`)).products; productList.innerHTML = products.map((product) => `<option value="${esc(product.code)}">${esc(product.description)}</option>`).join(""); } catch { /* opcional */ }
		});
		form.client.addEventListener("input", searchCustomers);
		form.productCode.addEventListener("input", searchProducts);
		form.client.addEventListener("change", () => {
			const match = customers.find((customer) => customer.name === form.client.value);
			if (match?.document && !form.clientDocument.value) { form.clientDocument.value = PP.formatDocument(match.document); }
			if (match) form.dataset.customerId = match.id; else delete form.dataset.customerId;
		});
		form.productCode.addEventListener("change", () => {
			const match = products.find((product) => product.code === form.productCode.value);
			if (match && !form.product.value) form.product.value = match.description;
			if (match) form.dataset.productId = match.id; else delete form.dataset.productId;
		});
	}

	// ---- Consulta ao Omie (pedido para vendas; nota fiscal para troca/garantia) --------
	async function bindOmieLookup() {
		const status = await api.get("/api/omie/status").catch(() => ({ configured: false }));
		const input = form.documentReference;
		if (!status.configured || !input) return;
		const isOrder = processType === "Pedido de venda";
		const button = document.createElement("button");
		button.type = "button";
		button.className = "button button-secondary compact-button";
		button.style.cssText = "align-self:end;justify-self:start;margin-bottom:2px";
		button.textContent = isOrder ? "Buscar pedido no Omie" : "Validar NF no Omie";
		input.closest("label").after(button);
		button.addEventListener("click", async () => {
			const number = input.value.trim();
			if (!number) return PP.setFieldError(input, isOrder ? "Informe o número do pedido." : "Informe o número da nota fiscal.");
			button.disabled = true;
			try {
				if (isOrder) {
					const { order } = await api.get(`/api/omie/orders/${encodeURIComponent(number)}`);
					if (order.customer) { form.client.value = order.customer.name; if (order.customer.document) form.clientDocument.value = PP.formatDocument(order.customer.document); }
					const [first, ...rest] = order.items;
					if (first) { form.productCode.value = first.productCode; form.product.value = first.description; form.quantity.value = first.quantity; if (form.unitPrice) form.unitPrice.value = first.unitPrice.toLocaleString("pt-BR", { minimumFractionDigits: 2 }); }
					rest.forEach((item) => window.__addItemRow?.(item));
					updateTotal();
					form.dataset.omieOrder = order.orderNumber;
					PP.toast(`Pedido ${order.orderNumber} importado do Omie (${order.items.length} item(ns)).`, "success");
				} else {
					const { invoice } = await api.get(`/api/omie/invoices/${encodeURIComponent(number)}`);
					if (invoice.customer.name && !form.client.value) form.client.value = invoice.customer.name;
					if (invoice.customer.document && !form.clientDocument.value) form.clientDocument.value = PP.formatDocument(invoice.customer.document);
					PP.toast(`NF ${invoice.number} encontrada no Omie (${invoice.customer.name || "destinatário"}, emitida em ${invoice.emittedAt || "—"}).`, "success");
				}
				PP.setFieldError(input, "");
				saveDraftSoon();
			} catch (error) { PP.setFieldError(input, error.message); } finally { button.disabled = false; }
		});
	}

	// ---- Rascunho ------------------------------------------------------------------
	const readForm = () => {
		const values = {};
		for (const element of form.elements) if (element.name && element.type !== "submit") values[element.name] = element.value;
		return { values, items: readItems(), savedAt: new Date().toISOString() };
	};
	const saveDraft = () => {
		const draft = readForm();
		const meaningful = Object.entries(draft.values).some(([name, value]) => value && !(name === "quantity" && value === "1")) || draft.items.length;
		try { if (meaningful) localStorage.setItem(draftKey, JSON.stringify(draft)); else localStorage.removeItem(draftKey); } catch { /* armazenamento indisponivel */ }
	};
	const saveDraftSoon = PP.debounce(saveDraft, 400);
	function restoreDraft(draft) {
		for (const [name, value] of Object.entries(draft.values)) if (form.elements[name]) form.elements[name].value = value;
		(draft.items || []).forEach((item) => window.__addItemRow?.(item));
		updateTotal();
	}
	function offerDraft() {
		let draft;
		try { draft = JSON.parse(localStorage.getItem(draftKey)); } catch { draft = null; }
		if (!draft) return;
		const banner = document.createElement("div");
		banner.className = "draft-banner";
		banner.innerHTML = `<span>Há um rascunho salvo em ${esc(PP.formatDateTime(draft.savedAt))}.</span><span><button type="button" class="button button-secondary compact-button" data-restore>Restaurar</button> <button type="button" class="button button-secondary compact-button" data-discard>Descartar</button></span>`;
		form.before(banner);
		banner.querySelector("[data-restore]").addEventListener("click", () => { restoreDraft(draft); banner.remove(); });
		banner.querySelector("[data-discard]").addEventListener("click", () => { localStorage.removeItem(draftKey); banner.remove(); });
	}

	// ---- Envio ---------------------------------------------------------------------
	function buildPayload() {
		const value = (name) => (form.elements[name] ? form.elements[name].value.trim() : "");
		const payload = { type: processType, client: value("client"), product: value("product"), productCode: value("productCode"), quantity: Number(form.quantity.value) };
		for (const name of ["clientDocument", "notes", ...config.fields]) {
			const raw = value(name);
			if (raw === "") continue;
			payload[name] = name === "unitPrice" ? PP.parseMoney(raw) : raw;
		}
		if (form.dataset.customerId) payload.customerId = Number(form.dataset.customerId);
		if (form.dataset.productId) payload.productId = Number(form.dataset.productId);
		if (form.dataset.omieOrder && form.dataset.omieOrder === payload.documentReference) payload.omieOrderNumber = form.dataset.omieOrder;
		const extra = readItems();
		if (extra.length) payload.items = [{ productCode: payload.productCode, description: payload.product, quantity: payload.quantity, ...(payload.unitPrice !== undefined ? { unitPrice: payload.unitPrice } : {}) }, ...extra];
		return payload;
	}

	function validateClient() {
		let valid = true;
		PP.clearFieldErrors(form);
		if (form.clientDocument.value && !PP.isValidDocument(form.clientDocument.value)) { PP.setFieldError(form.clientDocument, "CPF ou CNPJ inválido."); valid = false; }
		for (const element of form.elements) {
			if (element.required && !String(element.value).trim()) { PP.setFieldError(element, "Campo obrigatório."); valid = false; }
		}
		if (!valid) form.querySelector("[aria-invalid]")?.focus();
		return valid;
	}

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		feedback.textContent = "";
		if (!validateClient()) return;
		const button = form.querySelector("button[type=submit]");
		button.disabled = true;
		try {
			const result = await api.post("/api/cases", buildPayload());
			localStorage.removeItem(draftKey);
			window.location.href = `/caso.html?id=${encodeURIComponent(result.case.id)}&created=1`;
		} catch (error) {
			if (error.status === 0) { PP.outbox.add(buildPayload()); localStorage.removeItem(draftKey); PP.toast("Sem conexão. O processo foi guardado e será enviado quando a internet voltar.", "info"); form.reset(); }
			else if (!PP.applyServerErrors(form, error)) feedback.textContent = error.message;
			else feedback.textContent = "Corrija os campos destacados.";
		} finally { button.disabled = false; }
	});
	form.addEventListener("input", saveDraftSoon);

	try {
		const user = await PP.requireUser();
		if (!user) return;
		PP.fillProfile(user);
		PP.bindLogout();
		meta = await PP.meta();
		document.querySelector("#process-title").textContent = config.title;
		document.querySelector("#process-eyebrow").textContent = config.eyebrow;
		document.querySelector("#process-description").textContent = config.description;
		document.querySelector("#submit-label").textContent = config.submit;
		document.querySelector("#special-fields").innerHTML = config.fields.map((name) => fieldHtml[name]()).join("");
		PP.bindDocumentInput(form.clientDocument);
		if (form.unitPrice) PP.bindMoneyInput(form.unitPrice);
		addItemsBlock();
		bindOmieLookup();
		bindRegistry();
		form.addEventListener("input", updateTotal);
		offerDraft();
		window.PPShellTools?.mount();
	} catch (error) { feedback.textContent = error.message; }
})();
