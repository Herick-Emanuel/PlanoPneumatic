const sharedShellScript = document.createElement("script");
sharedShellScript.src = "/js/shared-shell.js";
document.head.appendChild(sharedShellScript);

(async () => {
	const PP = window.PP;
	const { esc, api } = PP;
	const form = document.querySelector("#search-form");
	const body = document.querySelector("#history-body");
	const count = document.querySelector("#result-count");
	const FILTERS_KEY = "history-filters";
	let state = { page: 1, pageSize: 25, sort: "updated_at", direction: "desc" };
	let canAssign = false;
	let selected = new Set();
	let lastResult = null;

	function formValues() {
		const values = {};
		for (const element of form.elements) {
			if (!element.name) continue;
			if (element.type === "checkbox") { if (element.checked) values[element.name] = element.value; }
			else if (element.value) values[element.name] = element.value;
		}
		return values;
	}
	const queryString = (extra = {}) => new URLSearchParams({ ...formValues(), ...extra }).toString();
	function applyValues(values) {
		for (const element of form.elements) {
			if (!element.name) continue;
			if (element.type === "checkbox") element.checked = values[element.name] === element.value; else element.value = values[element.name] || "";
		}
	}
	function persist() { try { sessionStorage.setItem(FILTERS_KEY, JSON.stringify({ ...formValues(), __sort: state.sort, __direction: state.direction })); } catch { /* sem sessionStorage */ } }

	function renderChips() {
		const labels = { process: "Processo", client: "Cliente", product: "Produto", productCode: "Código", document: "Documento", serial: "Série/lote", type: "Tipo", status: "Status", from: "De", to: "Até", mine: "Meus casos", overdue: "Atrasados", archived: "Arquivados", assignedTo: "Responsável" };
		const chips = Object.entries(formValues()).map(([name, value]) => `<button type="button" class="chip" data-clear="${esc(name)}" aria-label="Remover filtro ${esc(labels[name] || name)}">${esc(labels[name] || name)}${["mine", "overdue", "archived"].includes(name) ? "" : `: ${esc(name === "status" ? PP.statusLabel(value) : name === "assignedTo" ? form.assignedTo.selectedOptions[0]?.textContent : value)}`} ×</button>`).join("");
		let host = document.querySelector("#filter-chips");
		if (!host) { host = document.createElement("div"); host.id = "filter-chips"; host.className = "filter-chips"; form.after(host); }
		host.innerHTML = chips;
		host.querySelectorAll("[data-clear]").forEach((chip) => chip.addEventListener("click", () => { const element = form.elements[chip.dataset.clear]; if (element.type === "checkbox") element.checked = false; else element.value = ""; state.page = 1; load(); }));
	}

	function render(result) {
		lastResult = result;
		count.textContent = `${result.total} resultado${result.total === 1 ? "" : "s"}`;
		body.innerHTML = result.cases.map((item) => `<tr class="history-row sla-${esc(item.sla)}"><td>${canAssign ? `<input type="checkbox" data-select="${esc(item.id)}" aria-label="Selecionar ${esc(item.id)}" ${selected.has(item.id) ? "checked" : ""} />` : ""}</td><td><a class="table-link" href="/caso.html?id=${encodeURIComponent(item.id)}">${esc(item.id)}</a></td><td>${esc(item.client)}</td><td>${esc(item.type)}</td><td><span class="table-status ${PP.statusTone(item.status)}">${esc(PP.statusLabel(item.status))}</span></td><td>${PP.slaBadge(item)}</td><td>${esc(item.responsible)}</td><td class="muted">${esc(item.updatedAt)}</td></tr>`).join("")
			|| `<tr><td colspan="8">${PP.emptyState("Nenhum processo corresponde aos filtros", "Ajuste ou limpe os filtros para ver mais resultados.", '<button class="button button-secondary compact-button" type="button" data-empty-clear>Limpar filtros</button>')}</td></tr>`;
		body.querySelector("[data-empty-clear]")?.addEventListener("click", () => document.querySelector("#clear-filters").click());
		document.querySelector("#page-info").textContent = `Página ${result.page} de ${result.totalPages}`;
		document.querySelector("#prev-page").disabled = result.page <= 1;
		document.querySelector("#next-page").disabled = result.page >= result.totalPages;
		document.querySelectorAll("th.sortable").forEach((th) => th.setAttribute("aria-sort", th.dataset.sort === state.sort ? (state.direction === "asc" ? "ascending" : "descending") : "none"));
		const selectAll = document.querySelector("#select-all");
		selectAll.classList.toggle("hidden", !canAssign);
		selectAll.checked = false;
		body.querySelectorAll("[data-select]").forEach((box) => box.addEventListener("change", () => { if (box.checked) selected.add(box.dataset.select); else selected.delete(box.dataset.select); updateBulk(); }));
		updateBulk();
		renderChips();
	}

	function updateBulk() {
		const bar = document.querySelector("#bulk-bar");
		bar.classList.toggle("hidden", !selected.size);
		document.querySelector("#bulk-count").textContent = `${selected.size} selecionado${selected.size === 1 ? "" : "s"}`;
	}

	async function load() {
		persist();
		body.innerHTML = `<tr><td colspan="8">${PP.skeleton(5)}</td></tr>`;
		try { render(await api.get(`/api/cases?${queryString({ page: state.page, pageSize: state.pageSize, sort: state.sort, direction: state.direction })}`)); }
		catch (error) {
			body.innerHTML = `<tr><td colspan="8">${PP.errorState(error.message)}</td></tr>`;
			body.querySelector("[data-retry]")?.addEventListener("click", load);
		}
	}

	async function loadSavedFilters(selectId) {
		const select = document.querySelector("#saved-filters");
		const { filters } = await api.get("/api/filters");
		select.innerHTML = `<option value="">Selecione…</option>${filters.map((filter) => `<option value="${esc(filter.id)}">${esc(filter.name)}</option>`).join("")}`;
		select._filters = filters;
		if (selectId) select.value = selectId;
	}

	function exportCurrent(format) {
		const file = `relatorio-processos.${format}`;
		PP.download(`/api/reports/export.${format}?${queryString()}`, file).catch((error) => PP.toast(error.message, "error"));
	}

	try {
		const me = await PP.requireUser();
		if (!me) return;
		PP.fillProfile(me);
		PP.bindLogout();
		const meta = await PP.meta();
		canAssign = PP.can("cases.assign");
		form.type.insertAdjacentHTML("beforeend", meta.caseTypes.map((type) => `<option>${esc(type)}</option>`).join(""));
		form.status.insertAdjacentHTML("beforeend", meta.statuses.map((status) => `<option value="${esc(status.code)}">${esc(status.label)}</option>`).join(""));
		if (canAssign) {
			const { users } = await api.get("/api/users/assignable");
			form.assignedTo.insertAdjacentHTML("beforeend", users.map((user) => `<option value="${esc(user.id)}">${esc(user.name)}</option>`).join(""));
			document.querySelector("#bulk-assignee").innerHTML = users.map((user) => `<option value="${esc(user.id)}">${esc(user.name)}</option>`).join("");
		} else { form.assignedTo.closest("label").classList.add("hidden"); }

		let saved = null;
		try { saved = JSON.parse(sessionStorage.getItem(FILTERS_KEY)); } catch { /* ignora */ }
		const params = new URLSearchParams(window.location.search);
		if (saved) { state.sort = saved.__sort || state.sort; state.direction = saved.__direction || state.direction; applyValues(saved); }
		for (const [name, value] of params) if (form.elements[name]) applyValues({ ...formValues(), [name]: value });
		// "Meus casos" por padrao para operador, quando nao ha filtro salvo nem na URL.
		if (!saved && !params.size && me.role === "operator") form.mine.checked = true;

		form.addEventListener("submit", (event) => { event.preventDefault(); state.page = 1; selected = new Set(); load(); });
		document.querySelector("#clear-filters").addEventListener("click", () => { form.reset(); state.page = 1; selected = new Set(); load(); });
		document.querySelector("#prev-page").addEventListener("click", () => { state.page -= 1; load(); });
		document.querySelector("#next-page").addEventListener("click", () => { state.page += 1; load(); });
		document.querySelectorAll("th.sortable").forEach((th) => th.querySelector("button").addEventListener("click", () => {
			state = { ...state, page: 1, direction: state.sort === th.dataset.sort && state.direction === "desc" ? "asc" : "desc", sort: th.dataset.sort };
			load();
		}));
		document.querySelector("#select-all").addEventListener("change", (event) => {
			lastResult.cases.forEach((item) => (event.target.checked ? selected.add(item.id) : selected.delete(item.id)));
			body.querySelectorAll("[data-select]").forEach((box) => { box.checked = event.target.checked; });
			updateBulk();
		});
		document.querySelector("#bulk-assign").addEventListener("click", async () => {
			const assignedTo = Number(document.querySelector("#bulk-assignee").value);
			if (!(await PP.confirmAction("Atribuir processos", `Atribuir ${selected.size} processo(s) ao responsável escolhido?`, "Atribuir"))) return;
			try {
				const result = await api.post("/api/cases/bulk/assign", { caseNumbers: [...selected], assignedTo });
				const failed = result.results.filter((entry) => entry.status === "error");
				PP.toast(`${result.assigned} atribuído(s)${failed.length ? `, ${failed.length} com erro: ${failed[0].message}` : ""}.`, failed.length ? "error" : "success");
				selected = new Set();
				load();
			} catch (error) { PP.toast(error.message, "error"); }
		});
		document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => exportCurrent(button.dataset.export)));
		await loadSavedFilters().catch(() => {});
		const savedSelect = document.querySelector("#saved-filters");
		savedSelect.addEventListener("change", () => { const filter = savedSelect._filters.find((entry) => String(entry.id) === savedSelect.value); if (filter) { form.reset(); applyValues(filter.filters); state.page = 1; load(); } });
		document.querySelector("#save-filter").addEventListener("click", async () => {
			const answer = await PP.dialog({ title: "Salvar filtro", body: '<label>Nome do filtro<input name="name" maxlength="80" required /></label>', confirmLabel: "Salvar" });
			if (!answer) return;
			try { const result = await api.post("/api/filters", { name: answer.name, filters: formValues() }); await loadSavedFilters(result.filter.id); PP.toast("Filtro salvo.", "success"); } catch (error) { PP.toast(error.message, "error"); }
		});
		document.querySelector("#delete-filter").addEventListener("click", async () => {
			if (!savedSelect.value) return PP.toast("Escolha um filtro salvo para excluir.");
			await api.delete(`/api/filters/${savedSelect.value}`); await loadSavedFilters(); PP.toast("Filtro excluído.");
		});
		window.PPShellTools?.mount();
		await load();
	} catch (error) { body.innerHTML = `<tr><td colspan="8">${PP.errorState(error.message)}</td></tr>`; }
})();
