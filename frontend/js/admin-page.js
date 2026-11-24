const sharedShellScript = document.createElement("script");
sharedShellScript.src = "/js/shared-shell.js";
document.head.appendChild(sharedShellScript);

(async () => {
	const PP = window.PP;
	const { esc, api } = PP;
	const page = document.querySelector("[data-admin-page]");
	const pageType = page.dataset.adminPage;
	const content = () => document.querySelector("#page-content");
	const set = (html) => {
		content().innerHTML = html;
	};
	let me = null;

	const card = (label, value, tone = "blue") =>
		`<article class="indicator-card ${tone}"><div class="indicator-top"><span>${esc(label)}</span><span class="indicator-mark" aria-hidden="true">↗</span></div><strong>${esc(value)}</strong><small>Dados atuais</small></article>`;
	const loading = () => set(PP.skeleton(5));
	const failure = (error, retry) => {
		set(`<section class="panel">${PP.errorState(error.message)}</section>`);
		content().querySelector("[data-retry]")?.addEventListener("click", retry);
	};
	const section = (eyebrow, title, body, extra = "") =>
		`<section class="panel"><div class="panel-heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h2>${esc(title)}</h2></div>${extra}</div>${body}</section>`;
	const table = (heads, rows, empty = "Nenhum registro.") =>
		`<div class="table-wrap" tabindex="0"><table><thead><tr>${heads.map((head) => `<th>${esc(head)}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${heads.length}">${PP.emptyState(empty)}</td></tr>`}</tbody></table></div>`;
	const filterQuery = (form) => {
		const params = new URLSearchParams(new FormData(form));
		[...params.keys()].forEach((key) => {
			if (!params.get(key)) params.delete(key);
		});
		return params.toString();
	};

	// ------------------------------------------------ Importar / exportar em cada relatorio
	// Cada tabela de relatorio registra os dados que mostra; os botoes exportam exatamente isso (XLSX, CSV ou
	// PDF) e "Abrir planilha" carrega um arquivo exportado antes para comparar com o que esta na tela.
	// O mapa e global: a navegacao sem recarregar executa este script de novo, mas o clique ja esta ligado.
	const datasets = (window.__ppDatasets ||= new Map());
	let datasetSeq = datasets.size + Date.now();
	const dataTools = (title, columns, rows) => {
		if (!PP.can("reports.export")) return "";
		const id = `ds${(datasetSeq += 1)}`;
		datasets.set(id, { title, columns, rows });
		return `<div class="data-tools" data-dataset="${id}" role="group" aria-label="Exportar ou importar: ${esc(title)}"><button class="chip" type="button" data-table-export="xlsx" title="Baixar em Excel">${PP.icon("download")}Excel</button><button class="chip" type="button" data-table-export="csv" title="Baixar em CSV">CSV</button><button class="chip" type="button" data-table-export="pdf" title="Baixar em PDF">PDF</button><button class="chip" type="button" data-table-import title="Abrir uma planilha exportada antes para comparar">${PP.icon("import")}Abrir planilha</button></div>`;
	};
	const fileSlug = (title) =>
		String(title)
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "relatorio";
	const plainCell = (value) => (value === null || value === undefined ? "" : typeof value === "number" || typeof value === "boolean" ? value : String(value));
	const normalizeHeader = (value) =>
		String(value || "")
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.trim()
			.toLowerCase();
	const toNumber = (value) => {
		if (typeof value === "number") return value;
		const text = String(value ?? "")
			.trim()
			.replace(/\s/g, "");
		if (!text) return null;
		const parsed = Number(text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text);
		return Number.isFinite(parsed) ? parsed : null;
	};
	const readAsBase64 = (file) =>
		new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
			reader.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
			reader.readAsDataURL(file);
		});
	async function readSheet(file) {
		if (file.size > 6 * 1024 * 1024) throw new Error("Arquivo grande demais (máximo 6 MB).");
		if (/\.xlsx$/i.test(file.name)) return api.post("/api/reports/import-sheet", { fileName: file.name, content: await readAsBase64(file) });
		if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") throw new Error("Envie uma planilha .xlsx ou .csv exportada pelo sistema.");
		const rows = parseCsv((await file.text()).replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), ""));
		const columns = (rows.shift() || []).map((name) => name.trim());
		return { columns, rows: rows.slice(0, 5000), truncated: rows.length > 5000 };
	}
	// Compara a planilha com a tabela atual pela primeira coluna (ex.: Processo, Cliente, Tipo).
	function compareSheet(dataset, sheet, fileName) {
		const headerIndex = new Map(sheet.columns.map((header, index) => [normalizeHeader(header), index]));
		const keyColumn = dataset.columns[0];
		const keyIndex = headerIndex.get(normalizeHeader(keyColumn.header));
		const shared = dataset.columns.slice(1).filter((column) => headerIndex.has(normalizeHeader(column.header)));
		const intro = `<p class="muted">Arquivo <strong>${esc(fileName)}</strong>: ${sheet.rows.length} linha(s)${sheet.truncated ? " (somente as 5.000 primeiras)" : ""}. Nada é gravado no sistema; a planilha só é lida para conferência.</p>`;
		if (keyIndex === undefined || !shared.length) {
			const preview = sheet.rows.slice(0, 200).map((row) => `<tr>${sheet.columns.map((_, index) => `<td>${esc(row[index] ?? "")}</td>`).join("")}</tr>`);
			return `${intro}<p class="feedback">As colunas não batem com esta tabela (esperado: ${esc(dataset.columns.map((column) => column.header).join(", "))}). Mostrando o conteúdo da planilha.</p>${table(sheet.columns, preview, "Planilha vazia.")}`;
		}
		const imported = new Map(sheet.rows.map((row) => [String(row[keyIndex] ?? "").trim(), row]));
		const current = new Map(dataset.rows.map((row) => [String(plainCell(row[keyColumn.key])).trim(), row]));
		const keys = [...new Set([...current.keys(), ...imported.keys()])].filter(Boolean);
		const counts = { changed: 0, added: 0, removed: 0, same: 0 };
		const lines = keys.map((key) => {
			const now = current.get(key);
			const before = imported.get(key);
			let state = "same";
			const cells = shared.map((column) => {
				const nowValue = now ? plainCell(now[column.key]) : "";
				const beforeValue = before ? (before[headerIndex.get(normalizeHeader(column.header))] ?? "") : "";
				const nowNumber = toNumber(nowValue);
				const beforeNumber = toNumber(beforeValue);
				const numeric = typeof now?.[column.key] === "number" && nowNumber !== null && beforeNumber !== null;
				const differs = numeric ? nowNumber !== beforeNumber : String(nowValue).trim() !== String(beforeValue).trim();
				if (!now || !before) return `<td>${esc(now ? nowValue : beforeValue)}</td>`;
				if (!differs) return `<td>${esc(nowValue)}</td>`;
				state = "changed";
				const delta = numeric ? nowNumber - beforeNumber : null;
				return `<td class="diff-cell"><strong>${esc(nowValue)}</strong><small>planilha: ${esc(beforeValue)}${delta !== null ? ` · <span class="${delta > 0 ? "delta-up" : "delta-down"}">${delta > 0 ? "+" : ""}${esc(Math.round(delta * 100) / 100)}</span>` : ""}</small></td>`;
			});
			if (!before) state = "added";
			else if (!now) state = "removed";
			counts[state] += 1;
			const label = { changed: ["orange", "Alterado"], added: ["green", "Só agora"], removed: ["red", "Só na planilha"], same: ["", "Igual"] }[state];
			return {
				state,
				html: `<tr data-state="${state}"><td><strong>${esc(key)}</strong></td><td><span class="table-status ${label[0]}">${label[1]}</span></td>${cells.join("")}</tr>`
			};
		});
		const summary = `<div class="compare-summary"><span class="table-status orange">${counts.changed} alterado(s)</span><span class="table-status green">${counts.added} só agora</span><span class="table-status red">${counts.removed} só na planilha</span><span class="table-status">${counts.same} igual(is)</span><label class="check-inline"><input type="checkbox" data-only-diff checked /> Mostrar só diferenças</label></div>`;
		return `${intro}${summary}${table(
			[keyColumn.header, "Situação", ...shared.map((column) => column.header)],
			lines.map((line) => line.html),
			"Nenhuma linha para comparar."
		)}`;
	}
	function bindDataTools() {
		if (document.body.dataset.dataToolsBound) return;
		document.body.dataset.dataToolsBound = "1";
		document.addEventListener("click", async (event) => {
			const button = event.target.closest("[data-table-export], [data-table-import], [data-close-compare]");
			if (!button) return;
			if (button.matches("[data-close-compare]")) {
				button.closest(".compare-panel")?.remove();
				return;
			}
			const holder = button.closest("[data-dataset]");
			const dataset = datasets.get(holder?.dataset.dataset);
			if (!dataset) return;
			if (button.matches("[data-table-export]")) {
				const format = button.dataset.tableExport;
				button.disabled = true;
				try {
					await PP.downloadPost(
						"/api/reports/table-export",
						{
							title: dataset.title,
							format,
							columns: dataset.columns.map(({ key, header }) => ({ key, header })),
							rows: dataset.rows.map((row) => Object.fromEntries(dataset.columns.map((column) => [column.key, plainCell(row[column.key])])))
						},
						`${fileSlug(dataset.title)}.${format}`
					);
				} catch (error) {
					PP.toast(error.message, "error");
				} finally {
					button.disabled = false;
				}
				return;
			}
			const input = Object.assign(document.createElement("input"), { type: "file", accept: ".xlsx,.csv,text/csv" });
			input.addEventListener("change", async () => {
				const file = input.files[0];
				if (!file) return;
				// Abaixo da grade de paineis (largura total), ou logo abaixo do painel quando nao ha grade.
				const anchor = holder.closest(".content-grid, .team-performance-grid") || holder.closest(".panel") || holder;
				const panelId = `compare-${holder.dataset.dataset}`;
				document.getElementById(panelId)?.remove();
				const panel = document.createElement("section");
				panel.className = "panel compare-panel";
				panel.id = panelId;
				panel.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Planilha importada</p><h2>Comparação: ${esc(dataset.title)}</h2></div><button class="chip" type="button" data-close-compare>Fechar</button></div>${PP.skeleton(3)}`;
				anchor.after(panel);
				panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
				try {
					const sheet = await readSheet(file);
					panel.querySelector(".panel-heading").insertAdjacentHTML("afterend", compareSheet(dataset, sheet, file.name));
					panel.querySelector(".skeleton-list")?.remove();
					const toggle = panel.querySelector("[data-only-diff]");
					const applyFilter = () =>
						panel.querySelectorAll("tr[data-state]").forEach((row) => {
							row.hidden = toggle.checked && row.dataset.state === "same";
						});
					toggle?.addEventListener("change", applyFilter);
					if (toggle) applyFilter();
				} catch (error) {
					panel.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">Planilha importada</p><h2>Não foi possível abrir</h2></div><button class="chip" type="button" data-close-compare>Fechar</button></div><p class="feedback">${esc(error.message)}</p>`;
				}
			});
			input.click();
		});
	}

	// F11: envios agendados (o arquivo chega por e-mail com os filtros escolhidos).
	async function renderSchedules(host) {
		const [{ schedules }, meta] = await Promise.all([api.get("/api/reports/schedules"), PP.meta()]);
		const weekdays = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
		const hours = Array.from(
			{ length: 24 },
			(_, hour) => `<option value="${hour}" ${hour === 7 ? "selected" : ""}>${String(hour).padStart(2, "0")}h</option>`
		).join("");
		const rows = schedules.map(
			(item) =>
				`<tr><td><strong>${esc(item.name)}</strong>${item.filters?.type ? `<br><small class="muted">${esc(item.filters.type)}</small>` : ""}</td><td>${esc(item.description)}</td><td>${esc(item.format.toUpperCase())}</td><td>${item.lastSentAt ? esc(PP.formatDateTime(item.lastSentAt)) : "—"}${item.lastError ? `<br><small class="feedback">${esc(item.lastError)}</small>` : ""}</td><td><span class="table-status ${item.active ? "green" : "red"}">${item.active ? "Ativo" : "Pausado"}</span></td><td><div class="actions-cell"><button class="button button-secondary compact-button" type="button" data-send-schedule="${esc(item.id)}">Enviar agora</button><button class="button button-secondary compact-button" type="button" data-toggle-schedule="${esc(item.id)}" data-active="${!item.active}">${item.active ? "Pausar" : "Retomar"}</button><button class="button button-secondary compact-button" type="button" data-delete-schedule="${esc(item.id)}">Excluir</button></div></td></tr>`
		);
		host.innerHTML = section(
			"Automático",
			"Envios agendados",
			`<p class="muted">O relatório chega no seu e-mail como anexo. Cada envio traz o período desde o envio anterior (1 dia, 7 dias ou 1 mês), com as suas permissões atuais.</p><form id="schedule-form" class="create-user-form" novalidate><div class="editor-grid"><label>Nome<input name="name" maxlength="80" placeholder="Ex.: Garantias da semana" required /></label><label>Formato<select name="format"><option value="xlsx">Excel (XLSX)</option><option value="pdf">PDF</option><option value="csv">CSV</option></select></label><label>Frequência<select name="frequency"><option value="daily">Diário</option><option value="weekly" selected>Semanal</option><option value="monthly">Mensal (dia 1º)</option></select></label><label data-weekday>Dia da semana<select name="weekday">${weekdays.map((day, index) => `<option value="${index}" ${index === 1 ? "selected" : ""}>${day}</option>`).join("")}</select></label><label>Horário<select name="hour">${hours}</select></label><label>Tipo<select name="type"><option value="">Todos</option>${meta.caseTypes.map((type) => `<option>${esc(type)}</option>`).join("")}</select></label></div><div class="form-actions"><p id="schedule-feedback" class="feedback" role="alert"></p><button class="button button-primary" type="submit">Agendar envio</button></div></form>${table(["Nome", "Quando", "Formato", "Último envio", "Situação", "Ação"], rows, "Nenhum envio agendado.")}`
		);
		const form = host.querySelector("#schedule-form");
		const syncWeekday = () => {
			host.querySelector("[data-weekday]").hidden = form.frequency.value !== "weekly";
		};
		form.frequency.addEventListener("change", syncWeekday);
		syncWeekday();
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			const feedback = host.querySelector("#schedule-feedback");
			if (!form.name.value.trim()) {
				feedback.textContent = "Informe um nome.";
				return;
			}
			try {
				await api.post("/api/reports/schedules", {
					name: form.name.value,
					format: form.format.value,
					frequency: form.frequency.value,
					weekday: Number(form.weekday.value),
					hour: Number(form.hour.value),
					filters: form.type.value ? { type: form.type.value } : {}
				});
				PP.toast("Envio agendado.", "success");
				await renderSchedules(host);
			} catch (error) {
				feedback.textContent = error.message;
			}
		});
		host.querySelectorAll("[data-send-schedule]").forEach((button) =>
			button.addEventListener("click", async () => {
				button.disabled = true;
				try {
					const result = await api.post(`/api/reports/schedules/${button.dataset.sendSchedule}/send`, {});
					PP.toast(`Relatório enviado (${result.rows} processo(s)).`, "success");
				} catch (error) {
					PP.toast(error.message, "error");
				}
				await renderSchedules(host);
			})
		);
		host.querySelectorAll("[data-toggle-schedule]").forEach((button) =>
			button.addEventListener("click", async () => {
				try {
					await api.patch(`/api/reports/schedules/${button.dataset.toggleSchedule}`, { active: button.dataset.active === "true" });
					await renderSchedules(host);
				} catch (error) {
					PP.toast(error.message, "error");
				}
			})
		);
		host.querySelectorAll("[data-delete-schedule]").forEach((button) =>
			button.addEventListener("click", async () => {
				if (!(await PP.confirmAction("Excluir envio agendado", "O relatório deixa de ser enviado. Continuar?", "Excluir", true))) return;
				try {
					await api.delete(`/api/reports/schedules/${button.dataset.deleteSchedule}`);
					await renderSchedules(host);
				} catch (error) {
					PP.toast(error.message, "error");
				}
			})
		);
	}

	// ---------------------------------------------------------------- Relatorios
	async function reports() {
		const meta = await PP.meta();
		const exportable = PP.can("reports.export");
		const actions = document.querySelector(".topbar-actions");
		if (actions && !actions.dataset.ready) {
			actions.dataset.ready = "1";
			actions.querySelectorAll("a.button").forEach((link) => link.remove());
			if (exportable)
				actions.insertAdjacentHTML(
					"afterbegin",
					'<button class="button button-secondary compact-button" data-export="xlsx" type="button">Excel (XLSX)</button><button class="button button-secondary compact-button" data-export="pdf" type="button">PDF</button><button class="button button-secondary compact-button" data-export="csv" type="button">CSV</button>'
				);
		}
		const defaultFrom = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
		set(
			`<form id="report-filters" class="history-filters panel"><label>De<input name="from" type="date" value="${defaultFrom}" aria-describedby="report-period-hint" /></label><label>Até<input name="to" type="date" /></label><label>Tipo<select name="type"><option value="">Todos</option>${meta.caseTypes.map((type) => `<option>${esc(type)}</option>`).join("")}</select></label><div class="filter-actions"><button class="button button-primary" type="submit">Aplicar</button></div><p id="report-period-hint" class="muted filter-hint">Por padrão, os últimos 90 dias. Apague as datas para ver todo o período.</p></form><nav class="tabs" role="tablist" aria-label="Visões do relatório"><button class="active" role="tab" data-view="summary">Resumo</button><button role="tab" data-view="customer">Por cliente</button><button role="tab" data-view="product">Por produto (reincidência)</button><button role="tab" data-view="case">Por processo</button>${exportable ? '<button role="tab" data-view="schedules">Envios agendados</button>' : ""}</nav><div id="report-view" aria-live="polite"></div>`
		);
		const form = document.querySelector("#report-filters");
		const reportQuery = () => {
			const query = filterQuery(form);
			return form.from.value || form.to.value ? query : `${query}${query ? "&" : ""}period=all`;
		};
		let view = "summary";
		const renderView = async () => {
			const host = document.querySelector("#report-view");
			host.innerHTML = PP.skeleton(4);
			try {
				datasets.clear();
				if (view === "summary") {
					const data = await api.get(`/api/reports/summary?${reportQuery()}`);
					const tools = {
						byType: dataTools(
							"Casos por tipo",
							[
								{ key: "label", header: "Tipo" },
								{ key: "value", header: "Casos" }
							],
							data.byType
						),
						stalled: dataTools(
							"Processos vencidos",
							[
								{ key: "id", header: "Processo" },
								{ key: "client", header: "Cliente" },
								{ key: "type", header: "Tipo" },
								{ key: "status", header: "Status" },
								{ key: "responsible", header: "Responsável" },
								{ key: "dueAt", header: "Vencimento" }
							],
							data.stalled.map((item) => ({ ...item, status: PP.statusLabel(item.status), dueAt: PP.formatDateTime(item.dueAt) }))
						),
						productivity: dataTools(
							"Produtividade por responsável",
							[
								{ key: "user", header: "Responsável" },
								{ key: "total", header: "Processos" },
								{ key: "completed", header: "Concluídos" }
							],
							data.productivity
						),
						events: dataTools(
							"Eventos recentes",
							[
								{ key: "createdAt", header: "Data" },
								{ key: "id", header: "Processo" },
								{ key: "type", header: "Evento" },
								{ key: "description", header: "Descrição" },
								{ key: "responsible", header: "Responsável" }
							],
							data.events.map((event) => ({ ...event, createdAt: PP.formatDateTime(event.createdAt) }))
						)
					};
					host.innerHTML = `<section class="indicator-grid report-cards">${card("Total de casos", data.totals.total)}${card("Aguardando documento", data.totals.pending, "orange")}${card("Garantias em análise", data.totals.guarantees_in_analysis, "red")}${card("Concluídos", data.totals.completed, "green")}</section>
					<section class="content-grid report-grid"><article class="panel"><div class="panel-heading"><div><p class="eyebrow">Distribuição</p><h2>Casos por tipo</h2></div>${tools.byType}</div><div class="report-bars">${data.byType.map((item) => `<div class="report-bar"><div><strong>${esc(item.label)}</strong><span>${esc(item.value)}</span></div><i data-w="${Math.max(10, (item.value / Math.max(data.totals.total, 1)) * 100)}"></i></div>`).join("") || '<p class="muted">Sem dados.</p>'}</div></article>
					<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Prazo</p><h2>Processos vencidos</h2></div><span class="process-status">${data.stalled.length}</span>${tools.stalled}</div>${table(
						["Processo", "Cliente", "Status", "Vencimento"],
						data.stalled
							.slice(0, 10)
							.map(
								(item) =>
									`<tr><td><a class="table-link" href="/caso.html?id=${encodeURIComponent(item.id)}">${esc(item.id)}</a></td><td>${esc(item.client)}</td><td>${esc(PP.statusLabel(item.status))}</td><td>${esc(PP.formatDateTime(item.dueAt))}</td></tr>`
							),
						"Nenhum processo vencido."
					)}</article></section>
					<section class="content-grid report-grid"><article class="panel"><div class="panel-heading"><div><p class="eyebrow">Produtividade</p><h2>Por responsável</h2></div>${tools.productivity}</div>${table(
						["Responsável", "Processos", "Concluídos"],
						data.productivity.map((item) => `<tr><td>${esc(item.user)}</td><td>${esc(item.total)}</td><td>${esc(item.completed)}</td></tr>`)
					)}</article><article class="panel"><div class="panel-heading"><div><p class="eyebrow">Rastreabilidade</p><h2>Eventos recentes</h2></div>${tools.events}</div><div class="event-list" tabindex="0" aria-label="Eventos recentes (role para ver mais)">${data.events.map((event) => `<div class="event"><span>${esc(event.type)}</span><div><strong>${esc(event.id)} · ${esc(event.description)}</strong><small>${esc(event.responsible)} · ${esc(PP.formatDateTime(event.createdAt))}</small></div></div>`).join("") || '<p class="muted">Sem eventos.</p>'}</div></article></section>`;
				} else if (view === "customer" || view === "product") {
					const data = await api.get(`/api/reports/by-${view}?${reportQuery()}`);
					const title = view === "customer" ? "Ocorrências por cliente" : "Reincidência por produto";
					const columns = [
						...(view === "product"
							? [
									{ key: "key", header: "Código" },
									{ key: "label", header: "Produto" }
								]
							: [{ key: "label", header: "Cliente" }]),
						{ key: "total", header: "Total" },
						{ key: "warranties", header: "Garantias" },
						{ key: "exchanges", header: "Trocas" },
						{ key: "orders", header: "Pedidos" },
						{ key: "quantity", header: "Peças" },
						{ key: "lastAt", header: "Último movimento" }
					];
					host.innerHTML = section(
						view === "customer" ? "Clientes" : "Produtos",
						title,
						table(
							[view === "customer" ? "Cliente" : "Produto", "Total", "Garantias", "Trocas", "Pedidos", "Peças", "Último movimento"],
							data.rows.map(
								(row) =>
									`<tr><td><strong>${esc(row.label)}</strong>${view === "product" ? `<br><small class="muted">${esc(row.key)}</small>` : ""}</td><td>${esc(row.total)}</td><td>${row.warranties > 1 && view === "product" ? `<span class="table-status red">${esc(row.warranties)} (reincidente)</span>` : esc(row.warranties)}</td><td>${esc(row.exchanges)}</td><td>${esc(row.orders)}</td><td>${esc(row.quantity)}</td><td>${esc(PP.formatDateTime(row.lastAt))}</td></tr>`
							)
						),
						dataTools(
							title,
							columns,
							data.rows.map((row) => ({ ...row, lastAt: PP.formatDateTime(row.lastAt) }))
						)
					);
				} else if (view === "schedules") {
					await renderSchedules(host);
				} else {
					host.innerHTML = section(
						"Processo",
						"Relatório de um processo",
						'<form id="case-report-form" class="inline-form"><label>Número do processo<input name="id" placeholder="Ex.: GAR-2026-0045" required /></label><button class="button button-primary compact-button" type="submit">Gerar</button></form><div id="case-report" class="mt-16"></div>'
					);
					host.querySelector("#case-report-form").addEventListener("submit", async (event) => {
						event.preventDefault();
						const target = host.querySelector("#case-report");
						target.innerHTML = PP.skeleton(3);
						try {
							const { case: item } = await api.get(`/api/reports/by-case/${encodeURIComponent(event.currentTarget.id.value.trim())}`);
							const timelineTools = dataTools(
								`Linha do tempo ${item.id}`,
								[
									{ key: "createdAt", header: "Data" },
									{ key: "description", header: "Descrição" },
									{ key: "actor", header: "Responsável" }
								],
								item.events.map((entry) => ({
									createdAt: PP.formatDateTime(entry.createdAt),
									description: entry.description,
									actor: entry.actorName || entry.responsible
								}))
							);
							target.innerHTML = `<div class="kv-grid"><div><small>Processo</small><strong>${esc(item.id)}</strong></div><div><small>Cliente</small><strong>${esc(item.client)}</strong></div><div><small>Tipo</small><strong>${esc(item.type)}</strong></div><div><small>Status</small><strong>${esc(PP.statusLabel(item.status))}</strong></div><div><small>Responsável</small><strong>${esc(item.responsible)}</strong></div><div><small>Prazo</small><strong>${esc(PP.formatDateTime(item.dueAt))}</strong></div></div><div class="panel-heading mt-16"><h3>Linha do tempo</h3>${timelineTools}</div><div class="timeline scroll-box" tabindex="0" aria-label="Linha do tempo (role para ver mais)">${item.events.map((entry) => `<div class="timeline-entry"><strong>${esc(entry.description)}</strong><small>${esc(entry.actorName || entry.responsible)} · ${esc(PP.formatDateTime(entry.createdAt))}</small></div>`).join("")}</div><button class="button button-secondary compact-button" type="button" data-print>Imprimir</button>`;
							target.querySelector("[data-print]").addEventListener("click", () => window.print());
						} catch (error) {
							target.innerHTML = `<p class="feedback">${esc(error.message)}</p>`;
						}
					});
				}
			} catch (error) {
				host.innerHTML = PP.errorState(error.message);
				host.querySelector("[data-retry]")?.addEventListener("click", renderView);
			}
		};
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			renderView();
		});
		content()
			.querySelectorAll("[data-view]")
			.forEach((tab) =>
				tab.addEventListener("click", () => {
					view = tab.dataset.view;
					content()
						.querySelectorAll("[data-view]")
						.forEach((other) => other.classList.toggle("active", other === tab));
					renderView();
				})
			);
		document.querySelectorAll("[data-export]").forEach((button) => {
			if (button.dataset.bound) return;
			button.dataset.bound = "1";
			button.addEventListener("click", () =>
				PP.download(`/api/reports/export.${button.dataset.export}?${filterQuery(form)}`, `relatorio-processos.${button.dataset.export}`).catch((error) =>
					PP.toast(error.message, "error")
				)
			);
		});
		await renderView();
	}

	const memberColumns = [
		{ key: "name", header: "Integrante" },
		{ key: "team", header: "Time" },
		{ key: "role", header: "Perfil" },
		{ key: "casesRegistered", header: "Processos" },
		{ key: "partsRegistered", header: "Peças" },
		{ key: "casesThisMonth", header: "No mês" }
	];
	async function teamPerformance() {
		const data = await api.get("/api/reports/team-performance");
		const canGoal = PP.can("settings.manage");
		datasets.clear();
		const memberRow = (team) => (member) => ({ ...member, team: team.managerName, role: PP.roleLabel(member.role) });
		const allTools = dataTools(
			"Desempenho por time",
			memberColumns,
			data.teams.flatMap((team) => team.members.map(memberRow(team)))
		);
		const teamCards =
			data.teams
				.map(
					(team) =>
						`<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Time</p><h2>${esc(team.managerName)}</h2></div><span class="process-status">${esc(team.partsRegistered)} peças</span>${dataTools(`Time ${team.managerName}`, memberColumns, team.members.map(memberRow(team)))}</div>${team.managerId && team.monthlyTarget ? `<div class="distribution-row"><div><strong>Meta do mês</strong><span>${esc(team.casesThisMonth)}/${esc(team.monthlyTarget)} processos</span></div><i data-w="${Math.min(100, (team.casesThisMonth / team.monthlyTarget) * 100)}"></i></div>` : ""}${canGoal && team.managerId ? `<form class="inline-form" data-goal="${esc(team.managerId)}"><label>Meta mensal (processos)<input name="monthlyTarget" type="number" min="1" value="${esc(team.monthlyTarget || "")}" required /></label><button class="button button-secondary compact-button" type="submit">Salvar meta</button></form>` : ""}${table(
							["Integrante", "Perfil", "Processos", "Peças", "No mês"],
							team.members.map(
								(member) =>
									`<tr><td><strong>${esc(member.name)}</strong></td><td>${esc(PP.roleLabel(member.role))}</td><td>${esc(member.casesRegistered)}</td><td>${esc(member.partsRegistered)}</td><td>${esc(member.casesThisMonth)}</td></tr>`
							)
						)}</article>`
				)
				.join("") || PP.emptyState("Nenhum time encontrado");
		set(
			`${allTools ? `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">Todos os times</p><h2>Exportar ou comparar o desempenho completo</h2></div>${allTools}</div></section>` : ""}<section class="team-performance-grid">${teamCards}</section>`
		);
		content()
			.querySelectorAll("[data-goal]")
			.forEach((form) =>
				form.addEventListener("submit", async (event) => {
					event.preventDefault();
					try {
						await api.put(`/api/reports/team-goals/${form.dataset.goal}`, { monthlyTarget: Number(form.monthlyTarget.value) });
						PP.toast("Meta salva.", "success");
						await teamPerformance();
					} catch (error) {
						PP.toast(error.message, "error");
					}
				})
			);
	}

	async function managerPerformance() {
		const data = await api.get("/api/reports/manager-performance");
		datasets.clear();
		const tools = dataTools(
			"Desempenho dos gerentes",
			[
				{ key: "name", header: "Gerente" },
				{ key: "teamSize", header: "Time" },
				{ key: "totalActions", header: "Ações" },
				{ key: "navigationCount", header: "Navegações" },
				{ key: "clickCount", header: "Cliques" },
				{ key: "activeDays", header: "Dias ativos" },
				{ key: "lastActivityAt", header: "Última atividade" },
				{ key: "teamCases", header: "Casos do time" },
				{ key: "teamCompletedCases", header: "Concluídos" },
				{ key: "engagementScore", header: "Score" }
			],
			data.managers.map((manager) => ({ ...manager, lastActivityAt: manager.lastActivityAt ? PP.formatDateTime(manager.lastActivityAt) : "" }))
		);
		set(
			section(
				"Avaliação",
				"Desempenho dos gerentes",
				`<p class="muted">A pontuação de engajamento considera cliques, navegação, dias ativos e processos concluídos do time. Os dados de atividade são usados apenas para gestão operacional.</p>${table(
					["Gerente", "Time", "Ações", "Navegações", "Cliques", "Dias ativos", "Última atividade", "Casos do time", "Concluídos", "Score"],
					data.managers.map(
						(manager) =>
							`<tr><td><strong>${esc(manager.name)}</strong></td><td>${esc(manager.teamSize)}</td><td>${esc(manager.totalActions)}</td><td>${esc(manager.navigationCount)}</td><td>${esc(manager.clickCount)}</td><td>${esc(manager.activeDays)}</td><td>${manager.lastActivityAt ? esc(PP.formatDateTime(manager.lastActivityAt)) : "—"}</td><td>${esc(manager.teamCases)}</td><td>${esc(manager.teamCompletedCases)}</td><td><span class="table-status ${manager.engagementScore >= 60 ? "green" : manager.engagementScore >= 30 ? "orange" : "red"}">${esc(manager.engagementScore)}</span></td></tr>`
					),
					"Nenhum gerente cadastrado."
				)}`,
				`<span class="process-status">${data.managers.length} gerentes</span>${tools}`
			)
		);
	}

	// ------------------------------------------------- Construtor de relatorios
	// Administrador e gerente montam o relatorio (fonte, colunas ou agrupamento, filtros), salvam como modelo
	// e baixam quando quiserem. Modelos tambem podem ser exportados/importados como arquivo .json.
	const BUILDER_PRESETS = [
		{
			name: "Garantias atrasadas",
			description: "Garantias abertas com prazo (SLA) vencido.",
			definition: {
				source: "cases",
				columns: ["case_number", "client", "product", "status", "responsible", "due_at", "days_open"],
				filters: { type: "Garantia", overdue: "true" },
				sort: { key: "due_at", direction: "asc" }
			}
		},
		{
			name: "Peças por produto",
			description: "Total de processos, peças e valor agrupados por código de produto.",
			definition: {
				source: "cases",
				groupBy: "product_code",
				metrics: ["count", "quantity", "value"],
				filters: {},
				sort: { key: "quantity", direction: "desc" }
			}
		},
		{
			name: "Produtividade por responsável",
			description: "Processos, concluídos, atrasados e tempo médio por responsável.",
			definition: {
				source: "cases",
				groupBy: "responsible",
				metrics: ["count", "completed", "overdue", "avg_days"],
				filters: {},
				sort: { key: "count", direction: "desc" }
			}
		},
		{
			name: "Evolução mensal",
			description: "Processos criados por mês, com concluídos e valor.",
			definition: { source: "cases", groupBy: "month", metrics: ["count", "completed", "value"], filters: {}, sort: { key: "group", direction: "asc" } }
		},
		{
			name: "Movimentações do período",
			description: "Todos os eventos da linha do tempo, um por linha.",
			definition: {
				source: "events",
				columns: ["created_at", "case_number", "client", "event_type", "description", "responsible"],
				filters: {},
				sort: { key: "created_at", direction: "desc" }
			}
		}
	];

	async function reportsBuilder() {
		const [{ sources }, meta] = await Promise.all([api.get("/api/reports/custom/catalog"), PP.meta()]);
		const sourceByKey = Object.fromEntries(sources.map((source) => [source.key, source]));
		let templates = [];
		let editing = null; // modelo aberto (para "Salvar" atualizar em vez de criar)
		const exportable = PP.can("reports.export");
		const defaultFrom = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

		set(`<p class="muted builder-intro">Monte um relatório em 4 passos: <strong>1.</strong> escolha a fonte dos dados, <strong>2.</strong> escolha entre lista de registros ou totais agrupados, <strong>3.</strong> marque as colunas (ou métricas) e os filtros, <strong>4.</strong> pré-visualize, salve como modelo e baixe. Você só vê os processos que o seu perfil já pode ver.</p>
		<div class="builder-layout">
			<aside class="panel builder-side">
				<div class="panel-heading"><div><p class="eyebrow">Modelos</p><h2>Salvos</h2></div><button class="chip" type="button" id="builder-new">${PP.icon("plus")}Novo</button></div>
				<div id="builder-templates" class="builder-template-list" aria-live="polite">${PP.skeleton(3)}</div>
				<div class="builder-file-actions"><button class="button button-secondary compact-button" type="button" id="builder-import">${PP.icon("import")}Importar modelo (.json)</button></div>
				<p class="eyebrow mt-16">Comece por um pronto</p>
				<div class="builder-template-list">${BUILDER_PRESETS.map((preset, index) => `<button type="button" class="builder-template" data-preset="${index}"><strong>${esc(preset.name)}</strong><small>${esc(preset.description)}</small></button>`).join("")}</div>
			</aside>
			<form id="builder-form" class="panel builder-form" novalidate>
				<div class="panel-heading"><div><p class="eyebrow">Construtor</p><h2 id="builder-title">Novo relatório</h2></div></div>
				<fieldset><legend>1. Identificação</legend><div class="editor-grid"><label>Nome do relatório<input name="name" maxlength="80" placeholder="Ex.: Garantias do mês por cliente" required /></label><label>Descrição (opcional)<input name="description" maxlength="240" placeholder="Para que serve este relatório" /></label></div><label class="check-inline"><input type="checkbox" name="shared" /> Compartilhar com os outros gerentes e administradores</label></fieldset>
				<fieldset><legend>2. Fonte e formato</legend><div class="editor-grid"><label>Fonte dos dados<select name="source">${sources.map((source) => `<option value="${esc(source.key)}">${esc(source.label)}</option>`).join("")}</select></label><div class="builder-mode" role="radiogroup" aria-label="Formato"><label class="check-inline"><input type="radio" name="mode" value="list" checked /> Lista de registros (uma linha por item)</label><label class="check-inline"><input type="radio" name="mode" value="group" /> Totais agrupados (uma linha por grupo)</label></div></div></fieldset>
				<fieldset data-mode-list><legend>3. Colunas</legend><p class="muted">Marque o que deve aparecer, na ordem em que aparece na lista.</p><div class="builder-checks" id="builder-columns"></div></fieldset>
				<fieldset data-mode-group hidden><legend>3. Agrupamento e métricas</legend><div class="editor-grid"><label>Agrupar por<select name="groupBy" id="builder-group"></select></label></div><div class="builder-checks" id="builder-metrics"></div></fieldset>
				<fieldset><legend>4. Filtros</legend><div class="editor-grid"><label><span id="builder-date-label">Período</span> — de<input name="from" type="date" value="${defaultFrom}" /></label><label>até<input name="to" type="date" /></label><label>Tipo<select name="type"><option value="">Todos</option>${meta.caseTypes.map((type) => `<option>${esc(type)}</option>`).join("")}</select></label><label>Status<select name="status"><option value="">Todos</option>${meta.statuses.map((status) => `<option value="${esc(status.code)}">${esc(status.label)}</option>`).join("")}</select></label><label>Responsável contém<input name="responsible" maxlength="120" /></label><label>Cliente contém<input name="client" maxlength="120" /></label><label>Código do produto contém<input name="productCode" maxlength="120" /></label></div><label class="check-inline"><input type="checkbox" name="overdue" /> Somente processos atrasados</label> <label class="check-inline"><input type="checkbox" name="archived" /> Somente arquivados</label></fieldset>
				<fieldset><legend>5. Ordenação</legend><div class="editor-grid"><label>Ordenar por<select name="sortKey" id="builder-sort"></select></label><label>Direção<select name="direction"><option value="desc">Maior / mais recente primeiro</option><option value="asc">Menor / mais antigo primeiro</option></select></label></div></fieldset>
				<p id="builder-feedback" class="feedback" role="alert"></p>
				<div class="form-actions builder-actions">
					<button class="button button-secondary" type="button" id="builder-preview-button">Pré-visualizar</button>
					<button class="button button-secondary" type="button" id="builder-save-new">Salvar como novo</button>
					<button class="button button-primary" type="submit" id="builder-save">Salvar modelo</button>
				</div>
				${exportable ? `<div class="builder-download"><span class="muted">Baixar agora (até 5.000 linhas):</span><button class="chip" type="button" data-builder-export="xlsx">${PP.icon("download")}Excel</button><button class="chip" type="button" data-builder-export="csv">CSV</button><button class="chip" type="button" data-builder-export="pdf">PDF</button><button class="chip" type="button" id="builder-export-json">Exportar modelo (.json)</button></div>` : ""}
			</form>
		</div>
		<section class="panel" id="builder-preview" hidden></section>`);

		const form = document.querySelector("#builder-form");
		const feedback = document.querySelector("#builder-feedback");
		const mode = () => form.querySelector("[name=mode]:checked").value;
		const source = () => sourceByKey[form.source.value];
		const checkbox = (name, item, checked) =>
			`<label class="check-inline"><input type="checkbox" name="${name}" value="${esc(item.key)}" ${checked ? "checked" : ""} /> ${esc(item.header)}</label>`;

		function renderSortOptions(selected) {
			const current = selected ?? form.sortKey.value;
			const options =
				mode() === "group"
					? [
							{ key: "group", header: form.groupBy.selectedOptions[0]?.textContent || "Grupo" },
							...source().metrics.filter((metric) => form.querySelector(`[name=metric][value="${metric.key}"]`)?.checked)
						]
					: source().columns.filter((column) => form.querySelector(`[name=column][value="${column.key}"]`)?.checked);
			form.sortKey.innerHTML = `<option value="">Padrão</option>${options.map((option) => `<option value="${esc(option.key)}">${esc(option.header)}</option>`).join("")}`;
			if (options.some((option) => option.key === current)) form.sortKey.value = current;
		}
		function renderSource(definition = null) {
			const current = source();
			document.querySelector("#builder-date-label").textContent = current.dateLabel;
			const columns = definition?.columns || current.columns.slice(0, 6).map((column) => column.key);
			document.querySelector("#builder-columns").innerHTML = current.columns.map((column) => checkbox("column", column, columns.includes(column.key))).join("");
			form.groupBy.innerHTML = current.groups.map((group) => `<option value="${esc(group.key)}">${esc(group.header)}</option>`).join("");
			if (definition?.groupBy) form.groupBy.value = definition.groupBy;
			const metrics = definition?.metrics?.length ? definition.metrics : [current.metrics[0].key];
			document.querySelector("#builder-metrics").innerHTML = current.metrics.map((metric) => checkbox("metric", metric, metrics.includes(metric.key))).join("");
			// Filtros de processo valem para as duas fontes; "somente arquivados" so faz sentido para processos e eventos de processos arquivados.
			renderSortOptions(definition?.sort?.key || "");
		}
		function syncMode() {
			form.querySelector("[data-mode-list]").hidden = mode() !== "list";
			form.querySelector("[data-mode-group]").hidden = mode() !== "group";
			renderSortOptions();
		}
		function readDefinition() {
			const filters = {};
			["from", "to", "type", "status", "responsible", "client", "productCode"].forEach((name) => {
				if (form[name].value.trim()) filters[name] = form[name].value.trim();
			});
			if (form.overdue.checked) filters.overdue = "true";
			if (form.archived.checked) filters.archived = "true";
			const grouped = mode() === "group";
			return {
				source: form.source.value,
				columns: grouped ? [] : [...form.querySelectorAll("[name=column]:checked")].map((input) => input.value),
				groupBy: grouped ? form.groupBy.value : null,
				metrics: grouped ? [...form.querySelectorAll("[name=metric]:checked")].map((input) => input.value) : [],
				filters,
				sort: { key: form.sortKey.value || undefined, direction: form.direction.value }
			};
		}
		function validate(definition) {
			if (definition.groupBy && !definition.metrics.length) return "Marque ao menos uma métrica.";
			if (!definition.groupBy && !definition.columns.length) return "Marque ao menos uma coluna.";
			if (definition.filters.from && definition.filters.to && definition.filters.from > definition.filters.to) return "A data inicial é depois da final.";
			return "";
		}
		function loadDefinition({ name = "", description = "", shared = false, definition }, template = null) {
			editing = template && template.mine ? template : null;
			document.querySelector("#builder-title").textContent = editing
				? `Editando: ${editing.name}`
				: template
					? `${template.name} (de ${template.ownerName})`
					: name || "Novo relatório";
			form.name.value = name;
			form.description.value = description || "";
			form.shared.checked = Boolean(shared);
			form.source.value = sourceByKey[definition?.source] ? definition.source : sources[0].key;
			form.querySelector(`[name=mode][value=${definition?.groupBy ? "group" : "list"}]`).checked = true;
			const filters = definition?.filters || {};
			["from", "to", "type", "status", "responsible", "client", "productCode"].forEach((field) => {
				form[field].value = filters[field] || "";
			});
			if (!definition && !filters.from) form.from.value = defaultFrom;
			form.overdue.checked = filters.overdue === "true";
			form.archived.checked = filters.archived === "true";
			form.direction.value = definition?.sort?.direction || "desc";
			renderSource(definition);
			syncMode();
			if (definition?.sort?.key) form.sortKey.value = definition.sort.key;
			feedback.textContent = "";
			document.querySelector("#builder-preview").hidden = true;
		}

		async function renderTemplates() {
			const host = document.querySelector("#builder-templates");
			try {
				templates = (await api.get("/api/reports/templates")).templates;
			} catch (error) {
				host.innerHTML = `<p class="feedback">${esc(error.message)}</p>`;
				return;
			}
			host.innerHTML =
				templates
					.map(
						(template) =>
							`<div class="builder-template${editing?.id === template.id ? " active" : ""}"><button type="button" class="builder-template-open" data-open-template="${esc(template.id)}"><strong>${esc(template.name)}</strong><small>${esc(template.description || sourceByKey[template.definition.source]?.label || "")}${template.mine ? "" : ` · de ${esc(template.ownerName)}`}${template.shared ? " · compartilhado" : ""}</small></button><div class="actions-cell">${exportable ? `<button class="chip" type="button" data-template-export="${esc(template.id)}" title="Baixar em Excel">${PP.icon("download")}XLSX</button>` : ""}${template.mine ? `<button class="chip" type="button" data-template-delete="${esc(template.id)}">Excluir</button>` : ""}</div></div>`
					)
					.join("") || PP.emptyState("Nenhum modelo salvo", "Monte um relatório ao lado e clique em Salvar modelo.");
		}

		async function preview() {
			const definition = readDefinition();
			const problem = validate(definition);
			feedback.textContent = problem;
			if (problem) return;
			const host = document.querySelector("#builder-preview");
			host.hidden = false;
			host.innerHTML = PP.skeleton(4);
			try {
				const result = await api.post("/api/reports/custom/preview", { definition });
				const formatCell = (value, column) =>
					column.kind === "money" && value !== ""
						? PP.formatMoney?.(value) || Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
						: value;
				datasets.clear();
				const title = form.name.value.trim() || "Relatório personalizado";
				host.innerHTML = section(
					"Pré-visualização",
					title,
					`<p class="muted">${result.rows.length} linha(s)${result.truncated ? " — mostrando as 200 primeiras; o arquivo baixado traz até 5.000" : ""}.</p>${table(
						result.columns.map((column) => column.header),
						result.rows.map((row) => `<tr>${result.columns.map((column) => `<td>${esc(formatCell(row[column.key], column))}</td>`).join("")}</tr>`),
						"Nenhum registro com esses filtros."
					)}`,
					dataTools(title, result.columns, result.rows)
				);
				host.scrollIntoView({ behavior: "smooth", block: "start" });
			} catch (error) {
				host.innerHTML = `<p class="feedback">${esc(error.message)}</p>`;
			}
		}

		async function save(asNew) {
			const definition = readDefinition();
			const problem = !form.name.value.trim() ? "Dê um nome ao relatório para salvar." : validate(definition);
			feedback.textContent = problem;
			if (problem) {
				if (!form.name.value.trim()) form.name.focus();
				return;
			}
			const body = { name: form.name.value.trim(), description: form.description.value.trim(), shared: form.shared.checked, definition };
			try {
				const { template } = editing && !asNew ? await api.put(`/api/reports/templates/${editing.id}`, body) : await api.post("/api/reports/templates", body);
				editing = template;
				document.querySelector("#builder-title").textContent = `Editando: ${template.name}`;
				PP.toast("Modelo salvo.", "success");
				await renderTemplates();
			} catch (error) {
				feedback.textContent = error.message;
			}
		}

		const download = async (definition, format, title) => {
			try {
				await PP.downloadPost("/api/reports/custom/export", { definition, format, title }, `${fileSlug(title)}.${format}`);
			} catch (error) {
				PP.toast(error.message, "error");
			}
		};

		form.source.addEventListener("change", () => renderSource());
		form.querySelectorAll("[name=mode]").forEach((input) => input.addEventListener("change", syncMode));
		form.groupBy.addEventListener("change", () => renderSortOptions());
		form.addEventListener("change", (event) => {
			if (event.target.matches("[name=column], [name=metric]")) renderSortOptions();
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			save(false);
		});
		document.querySelector("#builder-save-new").addEventListener("click", () => save(true));
		document.querySelector("#builder-preview-button").addEventListener("click", preview);
		document.querySelector("#builder-new").addEventListener("click", () => loadDefinition({ definition: null }));
		form.querySelectorAll("[data-builder-export]").forEach((button) =>
			button.addEventListener("click", () => {
				const definition = readDefinition();
				const problem = validate(definition);
				feedback.textContent = problem;
				if (!problem) download(definition, button.dataset.builderExport, form.name.value.trim() || "Relatorio personalizado");
			})
		);
		document.querySelector("#builder-export-json")?.addEventListener("click", () => {
			const payload = {
				kind: "plano-pneumatic-report",
				version: 1,
				name: form.name.value.trim() || "Relatório personalizado",
				description: form.description.value.trim(),
				definition: readDefinition()
			};
			const link = Object.assign(document.createElement("a"), {
				href: URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })),
				download: `${fileSlug(payload.name)}.json`
			});
			link.click();
			setTimeout(() => URL.revokeObjectURL(link.href), 10000);
		});
		document.querySelector("#builder-import").addEventListener("click", () => {
			const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json" });
			input.addEventListener("change", async () => {
				const file = input.files[0];
				if (!file) return;
				try {
					if (file.size > 100000) throw new Error("Arquivo grande demais para um modelo.");
					const payload = JSON.parse(await file.text());
					if (payload?.kind !== "plano-pneumatic-report" || !payload.definition?.source)
						throw new Error("Este arquivo não é um modelo de relatório do Plano Pneumatic.");
					loadDefinition({
						name: String(payload.name || "").slice(0, 80),
						description: String(payload.description || "").slice(0, 240),
						definition: payload.definition
					});
					PP.toast("Modelo importado. Confira e clique em Salvar modelo para guardar.", "success");
				} catch (error) {
					PP.toast(error instanceof SyntaxError ? "Arquivo .json inválido." : error.message, "error");
				}
			});
			input.click();
		});
		document.querySelector(".builder-side").addEventListener("click", async (event) => {
			const presetButton = event.target.closest("[data-preset]");
			if (presetButton) {
				const preset = BUILDER_PRESETS[Number(presetButton.dataset.preset)];
				loadDefinition({ name: preset.name, description: preset.description, definition: preset.definition });
				form.scrollIntoView({ behavior: "smooth", block: "start" });
				return;
			}
			const openButton = event.target.closest("[data-open-template]");
			if (openButton) {
				const template = templates.find((item) => item.id === Number(openButton.dataset.openTemplate));
				if (template) loadDefinition(template, template);
				await renderTemplates();
				return;
			}
			const exportButton = event.target.closest("[data-template-export]");
			if (exportButton) {
				const template = templates.find((item) => item.id === Number(exportButton.dataset.templateExport));
				if (template) download(template.definition, "xlsx", template.name);
				return;
			}
			const deleteButton = event.target.closest("[data-template-delete]");
			if (deleteButton) {
				if (!(await PP.confirmAction("Excluir modelo", "O modelo deixa de aparecer para você e para quem o via compartilhado. Continuar?", "Excluir", true)))
					return;
				try {
					await api.delete(`/api/reports/templates/${deleteButton.dataset.templateDelete}`);
					if (editing?.id === Number(deleteButton.dataset.templateDelete)) loadDefinition({ definition: null });
					await renderTemplates();
				} catch (error) {
					PP.toast(error.message, "error");
				}
			}
		});

		loadDefinition({ definition: null });
		await renderTemplates();
	}

	// ------------------------------------------------------------- Configuracoes
	async function settingsPage() {
		const [{ settings, sla }, meta] = await Promise.all([api.get("/api/settings"), PP.meta()]);
		const editable = PP.can("settings.manage");
		const isAdmin = PP.can("users.create.any");
		const toggle = (key, title, hint, allowed = editable) =>
			`<label class="setting-row"><span><strong>${esc(title)}</strong><small>${esc(hint)}</small></span><input type="checkbox" data-setting="${esc(key)}" ${settings[key] ? "checked" : ""} ${allowed ? "" : "disabled"} /></label>`;
		const securityPanel = `<article class="panel"><p class="eyebrow">Segurança e privacidade</p><h2>Acesso aos dados</h2>${isAdmin ? "" : '<p class="muted">Somente o administrador altera estas opções.</p>'}${toggle("manager_team_scope", "Gerente vê só o próprio time", "Cada gerente vê apenas os processos criados por ou atribuídos a ele e aos usuários do seu time. Monte os times em Usuários antes de ligar.", isAdmin)}${toggle("mfa_required", "Verificação em duas etapas obrigatória", "Administradores e gerentes só acessam depois de ativar o código do celular (MFA).", isAdmin)}${toggle("activity_tracking", "Registro de navegação", "Guarda as telas visitadas para relatórios de uso (apagado automaticamente após o prazo de retenção).", isAdmin)}</article>`;
		set(`<section class="settings-grid"><article class="panel"><p class="eyebrow">Operação</p><h2>Configurações do sistema</h2>${editable ? "" : '<p class="muted">Somente gerentes e administradores alteram estas opções.</p>'}${toggle("alerts_enabled", "Alertas de prazo", "Exibir processos vencidos ou perto do vencimento no dashboard")}${toggle("auto_refresh", "Atualização automática", "Atualizar os indicadores do dashboard a cada minuto")}${toggle("require_documents", "Exigir documentação", "Bloquear conclusão e encerramento sem ao menos um anexo")}</article>
		<article class="panel"><p class="eyebrow">Prazos</p><h2>SLA por tipo (dias)</h2><p class="muted">O prazo conta da abertura e fica pausado enquanto o processo aguarda documento.</p>${sla.map((entry) => `<form class="inline-form" data-sla="${esc(entry.type)}"><label>${esc(entry.type)}<input name="days" type="number" min="1" max="365" value="${esc(entry.days)}" ${editable ? "" : "disabled"} required /></label>${editable ? '<button class="button button-secondary compact-button" type="submit">Salvar</button>' : ""}</form>`).join("")}</article>
		<article class="panel"><p class="eyebrow">Padrão operacional</p><h2>Status do fluxo</h2><div class="status-reference">${meta.statuses.map((status) => `<span class="table-status ${PP.statusTone(status.code)}">${esc(status.label)}</span>`).join("")}</div><p class="muted">Cada tipo de processo só permite as transições válidas; decisões (aprovar, improcedente, encerrar) exigem perfil de gerente ou técnico.</p></article>${securityPanel}</section>`);
		content()
			.querySelectorAll("[data-setting]")
			.forEach((input) =>
				input.addEventListener("change", async () => {
					try {
						await api.put(`/api/settings/${input.dataset.setting}`, { value: input.checked });
						PP.toast("Configuração salva.", "success");
					} catch (error) {
						input.checked = !input.checked;
						PP.toast(error.message, "error");
					}
				})
			);
		content()
			.querySelectorAll("[data-sla]")
			.forEach((form) =>
				form.addEventListener("submit", async (event) => {
					event.preventDefault();
					try {
						await api.put(`/api/sla/${encodeURIComponent(form.dataset.sla)}`, { days: Number(form.days.value) });
						PP.toast(`SLA de ${form.dataset.sla} atualizado.`, "success");
					} catch (error) {
						PP.toast(error.message, "error");
					}
				})
			);
	}

	const describeDevice = (userAgent) => {
		const text = String(userAgent || "");
		const browser = /Edg\//.test(text)
			? "Edge"
			: /OPR\//.test(text)
				? "Opera"
				: /Chrome\//.test(text)
					? "Chrome"
					: /Firefox\//.test(text)
						? "Firefox"
						: /Safari\//.test(text)
							? "Safari"
							: "Navegador";
		const system = /Android/.test(text)
			? "Android"
			: /iPhone|iPad/.test(text)
				? "iOS"
				: /Windows/.test(text)
					? "Windows"
					: /Mac OS X/.test(text)
						? "macOS"
						: /Linux/.test(text)
							? "Linux"
							: "";
		return text ? `${browser}${system ? ` no ${system}` : ""}` : "Aplicativo ou integração";
	};

	async function accountPage() {
		const { user, channels } = await api.get("/api/account");
		const channelToggle = (name, title, hint, checked, enabled) =>
			`<label class="setting-row"><span><strong>${esc(title)}</strong><small>${esc(hint)}</small></span><input type="checkbox" name="${name}" ${checked ? "checked" : ""} ${enabled ? "" : "disabled"} /></label>`;
		const channelsHtml = `<label>Celular (WhatsApp)<input name="phone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(user.phone || "")}" placeholder="(19) 99999-0000" /></label><fieldset class="account-channels"><legend>Onde receber os avisos</legend><p class="muted">Os avisos sempre aparecem no sino do sistema. Marque também os canais externos que quiser.</p>${channelToggle("notifyEmail", "E-mail", channels.email ? "Prazos, atribuições e menções no seu e-mail." : "Indisponível: o envio de e-mail ainda não foi configurado no servidor.", user.notifyEmail, channels.email)}${channelToggle("notifyWhatsapp", "WhatsApp", channels.whatsapp ? "Exige o celular preenchido acima. Você pode desligar quando quiser." : "Indisponível: o WhatsApp ainda não foi configurado no servidor.", user.notifyWhatsapp, channels.whatsapp)}</fieldset>`;
		set(`<div class="account-sections">
			<section class="panel account-panel"><p class="eyebrow">Meu acesso</p><h2>Dados da conta</h2><p class="muted">O perfil de acesso (${esc(PP.roleLabel(user.role))}) é administrado pelo sistema.</p><form id="account-form" class="form account-form" novalidate><label>Nome<input name="name" value="${esc(user.name)}" maxlength="120" required /></label><label>E-mail<input value="${esc(user.email)}" disabled /></label>${channelsHtml}<button class="button button-primary" type="submit">Salvar dados <span>→</span></button><p id="account-feedback" class="feedback" role="alert"></p></form></section>
			<section class="panel account-panel"><p class="eyebrow">Senha</p><h2>Trocar senha</h2><p class="muted">Ao trocar a senha, os outros aparelhos conectados saem da conta.</p><form id="password-form" class="form account-form" novalidate><label>Senha atual<input name="currentPassword" type="password" autocomplete="current-password" required /></label><label>Nova senha<input name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="72" required /></label><label>Confirme a nova senha<input name="confirmPassword" type="password" autocomplete="new-password" required /></label><p class="muted password-hint">Mínimo de 12 caracteres. Prefira uma frase com várias palavras; não use seu nome, e-mail ou o nome da empresa.</p><button class="button button-primary" type="submit">Trocar senha</button><p id="password-feedback" class="feedback" role="alert"></p></form></section>
			<section class="panel"><div class="panel-heading"><div><p class="eyebrow">Segurança</p><h2>Verificação em duas etapas (MFA)</h2></div><span id="mfa-status" class="process-status">…</span></div><div id="mfa-panel">${PP.skeleton(2)}</div></section>
			<section class="panel"><div class="panel-heading"><div><p class="eyebrow">Aparelhos</p><h2>Sessões ativas</h2></div><div class="actions-cell"><button class="button button-secondary compact-button" type="button" id="revoke-others" data-track="sair-outros-aparelhos">Sair dos outros aparelhos</button><button class="button button-danger compact-button" type="button" id="logout-all" data-track="sair-de-todos">Sair de todos</button></div></div><div id="sessions-panel">${PP.skeleton(3)}</div></section>
		</div>`);
		document.querySelector("#account-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = event.currentTarget;
			const feedback = document.querySelector("#account-feedback");
			if (form.notifyWhatsapp.checked && !form.phone.value.trim()) {
				feedback.textContent = "Preencha o celular para receber avisos pelo WhatsApp.";
				return;
			}
			try {
				const result = await api.patch("/api/account", {
					name: form.name.value,
					phone: form.phone.value,
					notifyEmail: form.notifyEmail.checked,
					notifyWhatsapp: form.notifyWhatsapp.checked
				});
				PP.fillProfile(result.user);
				feedback.textContent = "";
				PP.toast("Dados atualizados.", "success");
			} catch (error) {
				feedback.textContent = error.message;
			}
		});
		document.querySelector("#password-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = event.currentTarget;
			const feedback = document.querySelector("#password-feedback");
			feedback.textContent = "";
			if (form.newPassword.value.length < 12) {
				feedback.textContent = "A nova senha deve ter pelo menos 12 caracteres.";
				return;
			}
			if (form.newPassword.value !== form.confirmPassword.value) {
				feedback.textContent = "A confirmação não confere com a nova senha.";
				return;
			}
			try {
				const result = await api.post("/api/auth/change-password", { currentPassword: form.currentPassword.value, newPassword: form.newPassword.value });
				form.reset();
				PP.toast(
					result.otherSessionsEnded ? `Senha alterada. ${result.otherSessionsEnded} outro(s) aparelho(s) saíram da conta.` : "Senha alterada.",
					"success"
				);
				await loadSessions();
			} catch (error) {
				feedback.textContent = error.message;
			}
		});

		async function loadSessions() {
			const host = document.querySelector("#sessions-panel");
			try {
				const data = await api.get("/api/auth/sessions");
				host.innerHTML = `<p class="muted">Sessões sem uso por ${esc(Math.round((data.idleMinutes / 60) * 10) / 10)} h saem automaticamente.</p>${table(
					["Aparelho", "IP", "Entrou em", "Último uso", ""],
					data.sessions.map(
						(session) =>
							`<tr><td class="${session.current ? "session-current" : ""}">${esc(describeDevice(session.userAgent))}${session.current ? " (este aparelho)" : ""}</td><td>${esc(session.ip || "—")}</td><td>${esc(PP.formatDateTime(session.createdAt))}</td><td>${esc(PP.formatDateTime(session.lastSeenAt))}</td><td>${session.current ? "" : `<button class="button button-secondary compact-button" type="button" data-revoke-session="${esc(session.id)}">Encerrar</button>`}</td></tr>`
					),
					"Nenhuma sessão ativa."
				)}`;
				host.querySelectorAll("[data-revoke-session]").forEach((button) =>
					button.addEventListener("click", async () => {
						try {
							await api.delete(`/api/auth/sessions/${button.dataset.revokeSession}`);
							PP.toast("Sessão encerrada.", "success");
							await loadSessions();
						} catch (error) {
							PP.toast(error.message, "error");
						}
					})
				);
			} catch (error) {
				host.innerHTML = PP.errorState(error.message);
				host.querySelector("[data-retry]")?.addEventListener("click", loadSessions);
			}
		}
		document.querySelector("#revoke-others").addEventListener("click", async () => {
			try {
				const result = await api.post("/api/auth/sessions/revoke-others");
				PP.toast(`${result.sessionsEnded} sessão(ões) encerrada(s).`, "success");
				await loadSessions();
			} catch (error) {
				PP.toast(error.message, "error");
			}
		});
		document.querySelector("#logout-all").addEventListener("click", async () => {
			if (
				!(await PP.confirmAction(
					"Sair de todos os aparelhos",
					"Todas as sessões, inclusive esta, serão encerradas. Você precisará entrar de novo.",
					"Sair de todos",
					true
				))
			)
				return;
			try {
				await api.post("/api/auth/logout-all");
			} catch {
				/* sessao ja encerrada */
			}
			PP.clearSession();
			window.location.href = "/";
		});

		async function loadMfa() {
			const host = document.querySelector("#mfa-panel");
			const badge = document.querySelector("#mfa-status");
			try {
				const status = await api.get("/api/auth/mfa");
				badge.textContent = status.enabled ? "Ativa" : "Desativada";
				badge.className = `table-status ${status.enabled ? "green" : "orange"}`;
				if (!status.enabled) {
					host.innerHTML = `<p class="muted">Além da senha, o acesso passa a pedir um código de 6 dígitos gerado no celular. Mesmo que alguém descubra sua senha, não consegue entrar.${status.required ? " <strong>Obrigatória para o seu perfil.</strong>" : ""}</p><button class="button button-primary" type="button" id="mfa-start" data-track="mfa-ativar">Ativar verificação em duas etapas</button>`;
					host.querySelector("#mfa-start").addEventListener("click", () =>
						PP.mfaEnrollment(host, {
							onDone: () => {
								PP.toast("Verificação em duas etapas ativada. Os outros aparelhos saíram da conta.", "success");
								loadMfa();
								loadSessions();
							},
							onCancel: loadMfa
						})
					);
					return;
				}
				host.innerHTML = `<p class="muted">Restam <strong>${esc(status.recoveryCodesRemaining)}</strong> código(s) de recuperação.${status.recoveryCodesRemaining <= 3 ? " Gere novos códigos para não ficar sem acesso se perder o celular." : ""}</p><div class="form-actions"><button class="button button-secondary" type="button" id="mfa-codes">Gerar novos códigos de recuperação</button>${status.required ? "" : '<button class="button button-danger" type="button" id="mfa-disable">Desativar</button>'}</div>`;
				host.querySelector("#mfa-codes").addEventListener("click", async () => {
					const answer = await PP.dialog({
						title: "Gerar novos códigos",
						body: '<p>Os códigos antigos deixam de valer.</p><label>Código atual do aplicativo<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required /></label>',
						confirmLabel: "Gerar"
					});
					if (!answer) return;
					try {
						const result = await api.post("/api/auth/mfa/recovery-codes", { code: answer.code });
						PP.showRecoveryCodes(host, result.recoveryCodes, loadMfa, "Concluir");
					} catch (error) {
						PP.toast(error.message, "error");
					}
				});
				host.querySelector("#mfa-disable")?.addEventListener("click", async () => {
					const answer = await PP.dialog({
						title: "Desativar verificação em duas etapas",
						body: '<label>Senha<input name="password" type="password" autocomplete="current-password" required /></label><label>Código atual do aplicativo<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required /></label>',
						confirmLabel: "Desativar",
						danger: true
					});
					if (!answer) return;
					try {
						await api.post("/api/auth/mfa/disable", answer);
						PP.toast("Verificação em duas etapas desativada.", "success");
						await loadMfa();
					} catch (error) {
						PP.toast(error.message, "error");
					}
				});
			} catch (error) {
				host.innerHTML = PP.errorState(error.message);
				host.querySelector("[data-retry]")?.addEventListener("click", loadMfa);
			}
		}
		await Promise.all([loadSessions(), loadMfa()]);
	}

	// ------------------------------------------------------------------ Usuarios
	async function usersPage() {
		const data = await api.get("/api/users");
		const isAdmin = PP.can("users.create.any");
		const roleOptions = (isAdmin ? Object.keys(data.roles).filter((role) => role !== "admin") : ["operator"])
			.map((role) => `<option value="${esc(role)}">${esc(data.roles[role])}</option>`)
			.join("");
		const managers = data.users.filter((user) => user.role === "manager" && user.active);
		const managerOptions = (current) =>
			`<option value="">Sem time</option>${managers.map((manager) => `<option value="${esc(manager.id)}" ${manager.id === current ? "selected" : ""}>${esc(manager.name)}</option>`).join("")}`;
		set(
			section(
				"Acessos",
				"Usuários e perfis",
				`<form id="create-user-form" class="create-user-form" novalidate><div class="editor-grid"><label>Nome<input name="name" required /></label><label>E-mail<input name="email" type="email" required /></label><label>Senha inicial (mín. 12 caracteres)<input name="password" type="password" minlength="12" maxlength="72" autocomplete="new-password" placeholder="Ou envie um convite" /></label><label>Perfil<select name="role">${roleOptions}</select></label>${isAdmin ? `<label>Time<select name="managerId">${managerOptions(null)}</select></label>` : ""}</div><label class="inline-check"><input type="checkbox" name="invite" checked /> Enviar convite por e-mail (a pessoa cria a própria senha; o link vale 72 h)</label><div class="form-actions"><p id="create-user-feedback" class="feedback" role="alert"></p><button class="button button-primary" type="submit">Criar conta <span>+</span></button></div></form>${table(
					["Nome", "E-mail", "Perfil", "Time", "Status", "Ação"],
					data.users.map(
						(user) =>
							`<tr><td><strong>${esc(user.name)}</strong>${user.mfaEnabled || user.mustChangePassword ? `<div class="badge-row">${user.mfaEnabled ? '<span class="table-status green">MFA</span>' : ""}${user.mustChangePassword ? '<span class="table-status orange">Troca de senha pendente</span>' : ""}</div>` : ""}</td><td>${esc(user.email)}</td><td>${esc(data.roles[user.role] || user.role)}</td><td>${isAdmin && user.role === "operator" ? `<select data-transfer-user-id="${esc(user.id)}" aria-label="Time de ${esc(user.name)}">${managerOptions(user.managerId)}</select>` : esc(user.managerName || (user.role === "manager" ? "—" : "Sem time"))}</td><td><span class="table-status ${user.active ? "green" : "red"}">${user.active ? "Ativo" : "Bloqueado"}</span></td><td>${user.id === me.id ? "Conta atual" : `<div class="actions-cell"><button class="button button-secondary compact-button" type="button" data-status-user="${esc(user.id)}" data-active="${!user.active}" data-name="${esc(user.name)}">${user.active ? "Bloquear" : "Ativar"}</button><button class="button button-secondary compact-button" type="button" data-revoke-user="${esc(user.id)}" data-name="${esc(user.name)}">Encerrar sessões</button><button class="button button-secondary compact-button" type="button" data-unlock-user="${esc(user.id)}" data-name="${esc(user.name)}">Desbloquear login</button>${user.active ? `<button class="button button-secondary compact-button" type="button" data-invite-user="${esc(user.id)}" data-name="${esc(user.name)}">Reenviar convite</button>` : ""}${isAdmin ? `<button class="button button-secondary compact-button" type="button" data-edit-user="${esc(user.id)}">Editar</button><button class="button button-secondary compact-button" type="button" data-reset-user="${esc(user.id)}" data-name="${esc(user.name)}">Redefinir senha</button>${user.mfaEnabled ? `<button class="button button-secondary compact-button" type="button" data-mfa-reset="${esc(user.id)}" data-name="${esc(user.name)}">Remover MFA</button>` : ""}` : ""}</div>`}</td></tr>`
					)
				)}`,
				`<span class="process-status">${data.users.length} usuários</span>`
			)
		);
		const feedback = () => document.querySelector("#create-user-feedback");
		content()
			.querySelectorAll("[data-status-user]")
			.forEach((button) =>
				button.addEventListener("click", async () => {
					const active = button.dataset.active === "true";
					if (
						!active &&
						!(await PP.confirmAction(
							"Bloquear usuário",
							`${button.dataset.name} perderá o acesso e seus processos abertos serão reatribuídos ao gerente do time (ou a você). Continuar?`,
							"Bloquear",
							true
						))
					)
						return;
					try {
						const result = await api.patch(`/api/users/${button.dataset.statusUser}/status`, { active });
						if (result.reassignment?.reassigned) PP.toast(`${result.reassignment.reassigned} processo(s) reatribuído(s).`, "success");
						await usersPage();
					} catch (error) {
						feedback().textContent = error.message;
					}
				})
			);
		content()
			.querySelectorAll("[data-transfer-user-id]")
			.forEach((select) =>
				select.addEventListener("change", async () => {
					try {
						await api.patch(`/api/users/${select.dataset.transferUserId}/team`, { managerId: select.value || null });
						await usersPage();
					} catch (error) {
						feedback().textContent = error.message;
						select.disabled = false;
					}
				})
			);
		content()
			.querySelectorAll("[data-edit-user]")
			.forEach((button) =>
				button.addEventListener("click", async () => {
					const user = data.users.find((entry) => String(entry.id) === button.dataset.editUser);
					const answer = await PP.dialog({
						title: `Editar ${user.name}`,
						body: `<label>Nome<input name="name" value="${esc(user.name)}" required /></label><label>E-mail<input name="email" type="email" value="${esc(user.email)}" required /></label><label>Perfil<select name="role">${Object.keys(
							data.roles
						)
							.filter((role) => role !== "admin" || user.role === "admin")
							.map((role) => `<option value="${esc(role)}" ${role === user.role ? "selected" : ""}>${esc(data.roles[role])}</option>`)
							.join("")}</select></label><p class="muted">Mudar o perfil encerra as sessões do usuário.</p>`,
						confirmLabel: "Salvar"
					});
					if (!answer) return;
					try {
						await api.patch(`/api/users/${user.id}`, answer);
						PP.toast("Usuário atualizado.", "success");
						await usersPage();
					} catch (error) {
						PP.toast(error.message, "error");
					}
				})
			);
		content()
			.querySelectorAll("[data-reset-user]")
			.forEach((button) =>
				button.addEventListener("click", async () => {
					const answer = await PP.dialog({
						title: `Redefinir senha de ${button.dataset.name}`,
						body: '<label>Nova senha provisória (mín. 12 caracteres)<input name="password" type="password" minlength="12" maxlength="72" autocomplete="new-password" required /></label><p class="muted">Passe a senha à pessoa por um canal seguro. As sessões atuais serão encerradas e ela terá de criar uma senha pessoal no próximo acesso.</p>',
						confirmLabel: "Redefinir"
					});
					if (!answer) return;
					try {
						await api.post(`/api/users/${button.dataset.resetUser}/reset-password`, { password: answer.password });
						PP.toast("Senha provisória definida.", "success");
						await usersPage();
					} catch (error) {
						PP.toast(error.message, "error");
					}
				})
			);
		content()
			.querySelectorAll("[data-revoke-user]")
			.forEach((button) =>
				button.addEventListener("click", async () => {
					if (
						!(await PP.confirmAction(
							"Encerrar sessões",
							`${button.dataset.name} sairá da conta em todos os aparelhos (use em caso de aparelho perdido ou suspeita de acesso indevido).`,
							"Encerrar",
							true
						))
					)
						return;
					try {
						const result = await api.post(`/api/users/${button.dataset.revokeUser}/sessions/revoke`);
						PP.toast(`${result.sessionsEnded} sessão(ões) encerrada(s).`, "success");
					} catch (error) {
						PP.toast(error.message, "error");
					}
				})
			);
		content()
			.querySelectorAll("[data-invite-user]")
			.forEach((button) =>
				button.addEventListener("click", async () => {
					if (
						!(await PP.confirmAction(
							"Reenviar convite",
							`Enviar a ${button.dataset.name} um link para criar a senha? Links anteriores deixam de valer.`,
							"Enviar"
						))
					)
						return;
					try {
						const result = await api.post(`/api/users/${button.dataset.inviteUser}/invite`, {});
						PP.toast(
							result.mailConfigured === false ? "E-mail não configurado no servidor." : "Convite enviado.",
							result.mailConfigured === false ? "info" : "success"
						);
					} catch (error) {
						PP.toast(error.message, "error");
					}
				})
			);
		content()
			.querySelectorAll("[data-unlock-user]")
			.forEach((button) =>
				button.addEventListener("click", async () => {
					try {
						const result = await api.post(`/api/users/${button.dataset.unlockUser}/unlock-login`);
						PP.toast(result.cleared ? `Login de ${button.dataset.name} desbloqueado.` : `${button.dataset.name} não estava bloqueado.`, "success");
					} catch (error) {
						PP.toast(error.message, "error");
					}
				})
			);
		content()
			.querySelectorAll("[data-mfa-reset]")
			.forEach((button) =>
				button.addEventListener("click", async () => {
					if (
						!(await PP.confirmAction(
							"Remover verificação em duas etapas",
							`Use quando ${button.dataset.name} perdeu o celular e os códigos de recuperação. Confirme a identidade da pessoa antes. Ela sairá de todos os aparelhos.`,
							"Remover MFA",
							true
						))
					)
						return;
					try {
						await api.post(`/api/users/${button.dataset.mfaReset}/mfa/reset`);
						PP.toast("MFA removido.", "success");
						await usersPage();
					} catch (error) {
						PP.toast(error.message, "error");
					}
				})
			);
		document.querySelector("#create-user-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = event.currentTarget;
			const button = form.querySelector("button[type=submit]");
			button.disabled = true;
			feedback().textContent = "";
			try {
				const invite = form.invite.checked;
				if (!invite && form.password.value.length < 12) throw new Error("Defina uma senha inicial com 12 caracteres ou marque o envio de convite.");
				const result = await api.post("/api/users", {
					name: form.name.value,
					email: form.email.value,
					password: invite ? undefined : form.password.value,
					invite,
					role: form.role.value,
					managerId: form.managerId ? form.managerId.value || undefined : undefined
				});
				PP.toast(
					result.invited
						? result.mailConfigured
							? "Conta criada e convite enviado."
							: "Conta criada. O e-mail não está configurado: o convite não foi enviado."
						: "Conta criada.",
					result.invited && !result.mailConfigured ? "info" : "success"
				);
				await usersPage();
			} catch (error) {
				feedback().textContent = error.message;
			} finally {
				button.disabled = false;
			}
		});
	}

	// -------------------------------------------------- Notificacoes e auditoria
	async function notificationsPage() {
		const render = async () => {
			const data = await api.get("/api/notifications");
			set(
				section(
					"Central",
					"Notificações",
					`<div class="inline-form"><button class="button button-secondary compact-button" type="button" id="read-all">Marcar todas como lidas</button></div>${table(
						["", "Mensagem", "Processo", "Quando"],
						data.notifications.map(
							(item) =>
								`<tr><td>${item.readAt ? "" : '<span class="table-status blue">Nova</span>'}</td><td>${esc(item.message)}</td><td>${item.caseNumber ? `<a class="table-link" href="/caso.html?id=${encodeURIComponent(item.caseNumber)}" data-read="${esc(item.id)}">${esc(item.caseNumber)}</a>` : "—"}</td><td>${esc(PP.formatDateTime(item.createdAt))}</td></tr>`
						),
						"Nenhuma notificação por aqui."
					)}`,
					`<span class="process-status">${data.unread} não lidas</span>`
				)
			);
			document.querySelector("#read-all").addEventListener("click", async () => {
				await api.post("/api/notifications/read-all");
				window.PPShellTools?.refreshNotifications();
				render();
			});
			content()
				.querySelectorAll("[data-read]")
				.forEach((link) =>
					link.addEventListener("click", () => {
						api.patch(`/api/notifications/${link.dataset.read}/read`).catch(() => {});
					})
				);
		};
		await render();
	}

	// Auditoria geral (P2): login, falhas, sessoes, MFA, usuarios, configuracoes e eventos de processos, com IP.
	const auditDetails = (item) => {
		const details = item.details || {};
		if (item.action === "CASE_EVENT") {
			const changes = details.changes?.changes
				? Object.entries(details.changes.changes)
						.map(([field, change]) => `${field}: ${change.before ?? "—"} → ${change.after ?? "—"}`)
						.join("; ")
				: "";
			return [details.description, changes].filter(Boolean).join(" · ");
		}
		return Object.entries(details)
			.filter(([, value]) => value !== null && typeof value !== "object")
			.map(([key, value]) => `${key}: ${value}`)
			.join(", ");
	};
	async function auditPage() {
		const params = new URLSearchParams(window.location.search);
		const query = new URLSearchParams();
		for (const key of ["action", "caseNumber", "from", "to"]) if (params.get(key)) query.set(key, params.get(key));
		const data = await api.get(`/api/audit?${query}`);
		const actionOptions = Object.entries(data.actions)
			.map(([code, label]) => `<option value="${esc(code)}" ${params.get("action") === code ? "selected" : ""}>${esc(label)}</option>`)
			.join("");
		const target = (item) =>
			item.caseNumber
				? `<a href="/caso.html?id=${encodeURIComponent(item.caseNumber)}">${esc(item.caseNumber)}</a>`
				: esc(item.targetName || (item.entityType === "login" ? item.entityId : item.entityType === "setting" ? item.entityId : "") || "—");
		set(
			section(
				"Rastreabilidade",
				"Auditoria",
				`<form id="audit-filters" class="audit-filters"><label>Ação<select name="action"><option value="">Todas</option>${actionOptions}</select></label><label>Processo<input name="caseNumber" value="${esc(params.get("caseNumber") || "")}" placeholder="Ex.: GAR-2026-0045" /></label><label>De<input name="from" type="date" value="${esc(params.get("from") || "")}" /></label><label>Até<input name="to" type="date" value="${esc(params.get("to") || "")}" /></label><button class="button button-primary compact-button" type="submit">Filtrar</button><a class="button button-secondary compact-button" href="/auditoria.html">Limpar</a></form>${table(
					["Quando", "Quem", "Ação", "Alvo", "IP", "Detalhes"],
					data.audit.map(
						(item) =>
							`<tr><td>${esc(PP.formatDateTime(item.createdAt))}</td><td>${esc(item.actorName || "—")}</td><td>${esc(data.actions[item.action] || item.action)}</td><td>${target(item)}</td><td title="${esc(item.userAgent || "")}">${esc(item.ip || "—")}</td><td class="muted audit-details">${esc(auditDetails(item))}</td></tr>`
					),
					"Nenhum registro de auditoria."
				)}`,
				`<span class="process-status">${data.audit.length} registros${data.audit.length >= 200 ? " (mais recentes)" : ""}</span>`
			)
		);
		document.querySelector("#audit-filters").addEventListener("submit", (event) => {
			event.preventDefault();
			const next = new URLSearchParams();
			for (const [key, value] of new FormData(event.currentTarget)) if (String(value).trim()) next.set(key, String(value).trim());
			window.location.search = next.toString();
		});
	}

	// --------------------------------------------------------------- Integracoes
	async function omieSection() {
		const status = await api.get("/api/omie/sync").catch(() => ({ configured: false, runs: [] }));
		const kindLabel = { customers: "Clientes", products: "Produtos" };
		const runs = table(
			["Quando", "Tipo", "Origem", "Resultado", "Novos", "Atualizados", "Ignorados"],
			status.runs
				.slice(0, 8)
				.map(
					(run) =>
						`<tr><td>${esc(PP.formatDateTime(run.startedAt))}</td><td>${esc(kindLabel[run.kind] || run.kind)}</td><td>${run.trigger === "scheduled" ? "Agendada" : `Manual (${esc(run.startedBy || "—")})`}</td><td><span class="table-status ${run.status === "success" ? "green" : run.status === "error" ? "red" : "orange"}" title="${esc(run.message || "")}">${run.status === "success" ? "Concluída" : run.status === "error" ? "Erro" : "Em andamento"}</span></td><td>${esc(run.created)}</td><td>${esc(run.updated)}</td><td>${esc(run.skipped)}</td></tr>`
				),
			"Nenhuma sincronização ainda."
		);
		return section(
			"ERP",
			"Omie",
			`<p class="muted">Importa clientes e produtos do Omie para os cadastros (carga completa na primeira vez, depois só o que mudou; rotina automática a cada 24 h). Pedidos e notas fiscais são consultados ao abrir um processo.</p>${status.configured ? `<div class="inline-form"><button class="button button-primary compact-button" type="button" data-omie-sync="all">Sincronizar agora</button><button class="button button-secondary compact-button" type="button" data-omie-sync="customers">Só clientes</button><button class="button button-secondary compact-button" type="button" data-omie-sync="products">Só produtos</button><span id="omie-feedback" class="muted" role="status"></span></div>` : '<p class="feedback">Integração não configurada: defina OMIE_APP_KEY e OMIE_APP_SECRET no servidor.</p>'}${runs}`
		);
	}
	async function integrationsPage() {
		const [{ webhooks }, meta, omieHtml] = await Promise.all([api.get("/api/integrations/webhooks"), PP.meta(), omieSection()]);
		set(
			omieHtml +
				section(
					"Eventos",
					"Webhooks",
					`<form id="webhook-form" class="create-user-form" novalidate><div class="editor-grid"><label>Nome<input name="name" required maxlength="120" /></label><label>Endpoint HTTPS<input name="endpointUrl" type="url" placeholder="https://" required /></label><label>Segredo (assinatura HMAC)<input name="secret" type="password" autocomplete="off" required /></label><fieldset class="plain-fieldset"><legend class="plain-legend">Eventos</legend>${meta.webhookEvents.map((event) => `<label class="checkbox-row"><input type="checkbox" name="events" value="${esc(event)}" checked /> ${esc(event)}</label>`).join("")}</fieldset></div><div class="form-actions"><p id="webhook-feedback" class="feedback" role="alert"></p><button class="button button-primary" type="submit">Criar webhook</button></div></form>${table(
						["Nome", "Endpoint", "Eventos", "Status", "Ação"],
						webhooks.map(
							(hook) =>
								`<tr><td><strong>${esc(hook.name)}</strong></td><td>${esc(hook.endpointUrl)}</td><td>${esc((hook.events || []).join(", "))}</td><td><span class="table-status ${hook.active ? "green" : "red"}">${hook.active ? "Ativo" : "Inativo"}</span></td><td><div class="actions-cell"><button class="button button-secondary compact-button" type="button" data-toggle-hook="${esc(hook.id)}" data-active="${!hook.active}">${hook.active ? "Desativar" : "Ativar"}</button><button class="button button-secondary compact-button" type="button" data-deliveries="${esc(hook.id)}">Entregas</button></div></td></tr>`
						),
						"Nenhum webhook configurado."
					)}<div id="deliveries"></div>`
				)
		);
		content()
			.querySelectorAll("[data-omie-sync]")
			.forEach((button) =>
				button.addEventListener("click", async () => {
					const note = document.querySelector("#omie-feedback");
					content()
						.querySelectorAll("[data-omie-sync]")
						.forEach((other) => {
							other.disabled = true;
						});
					note.textContent = "Sincronizando… isso pode levar alguns minutos.";
					try {
						const result = await api.post("/api/omie/sync", { kind: button.dataset.omieSync });
						PP.toast(`Omie: ${result.results.map((item) => `${item.created} novos, ${item.updated} atualizados`).join(" | ")}.`, "success");
						await integrationsPage();
					} catch (error) {
						PP.toast(error.message, "error");
						await integrationsPage();
					}
				})
			);
		const feedback = document.querySelector("#webhook-feedback");
		document.querySelector("#webhook-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = event.currentTarget;
			try {
				await api.post("/api/integrations/webhooks", {
					name: form.name.value,
					endpointUrl: form.endpointUrl.value,
					secret: form.secret.value,
					events: [...form.querySelectorAll('[name="events"]:checked')].map((box) => box.value)
				});
				PP.toast("Webhook criado.", "success");
				await integrationsPage();
			} catch (error) {
				feedback.textContent = error.message;
			}
		});
		content()
			.querySelectorAll("[data-toggle-hook]")
			.forEach((button) =>
				button.addEventListener("click", async () => {
					await api.patch(`/api/integrations/webhooks/${button.dataset.toggleHook}`, { active: button.dataset.active === "true" });
					await integrationsPage();
				})
			);
		content()
			.querySelectorAll("[data-deliveries]")
			.forEach((button) =>
				button.addEventListener("click", async () => {
					const { deliveries } = await api.get(`/api/integrations/webhooks/${button.dataset.deliveries}/deliveries`);
					document.querySelector("#deliveries").innerHTML = `<h3>Últimas entregas</h3>${table(
						["Quando", "Evento", "Tentativa", "Resultado"],
						deliveries.map(
							(item) =>
								`<tr><td>${esc(PP.formatDateTime(item.createdAt))}</td><td>${esc(item.event)}</td><td>${esc(item.attempt)}</td><td><span class="table-status ${item.success ? "green" : "red"}">${item.success ? `OK ${esc(item.statusCode)}` : esc(item.error || "Falha")}</span></td></tr>`
						),
						"Nenhuma entrega registrada."
					)}`;
				})
			);
	}

	// -------------------------------------------------- Cadastro de clientes/produtos
	// Envio de pecas ao Omie: rotulos, cor e unidades aceitas.
	const OMIE_UNITS = ["UN", "PC", "KIT", "CJ", "M", "L"];
	const OMIE_STATUS = {
		pending_approval: ["orange", "Aguardando aprovação"],
		sending: ["blue", "Enviando…"],
		synced: ["green", "No Omie"],
		error: ["red", "Erro no envio"],
		none: ["", "Não enviada"]
	};
	const unitOptions = (selected) => OMIE_UNITS.map((unit) => `<option value="${unit}" ${unit === selected ? "selected" : ""}>${unit}</option>`).join("");
	const formatNcm = (value) => {
		const digits = String(value || "")
			.replace(/\D/g, "")
			.slice(0, 8);
		return digits.length > 6
			? `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`
			: digits.length > 4
				? `${digits.slice(0, 4)}.${digits.slice(4)}`
				: digits;
	};
	const bindNcmInputs = (root) =>
		root.querySelectorAll("[data-ncm]").forEach((input) =>
			input.addEventListener("input", () => {
				input.value = formatNcm(input.value);
			})
		);

	async function registryPage() {
		const canManage = PP.can("registry.manage");
		const canApprove = PP.can("registry.omie.approve");
		let tab = "customers";
		let pollCount = 0;
		const selectedProducts = new Set();
		const render = async () => {
			const isCustomers = tab === "customers";
			const q = document.querySelector("#registry-search")?.value || "";
			const omieFilter = document.querySelector("#registry-omie-filter")?.value || "";
			const data = await api.get(
				`/api/${tab}?limit=100&includeInactive=${canManage}${q ? `&q=${encodeURIComponent(q)}` : ""}${!isCustomers && omieFilter ? `&omie=${omieFilter}` : ""}`
			);
			const rows = isCustomers ? data.customers : data.products;
			const omieOn = !isCustomers && Boolean(data.omieConfigured);
			// Representante padrao do cliente (controle de carcacas).
			const reps = isCustomers ? (await api.get("/api/representatives").catch(() => ({ representatives: [] }))).representatives : [];
			const repSelect = (selected) =>
				`<label>Representante<select name="representativeId"><option value="">Sem representante</option>${reps
					.map((rep) => `<option value="${esc(rep.id)}" ${String(rep.id) === String(selected ?? "") ? "selected" : ""}>${esc(rep.name)}</option>`)
					.join("")}</select></label>`;
			const remanufacturedBox = (checked) =>
				`<label class="check-inline"><input type="checkbox" name="remanufactured" value="true" ${checked ? "checked" : ""} /> Remanufaturada (a venda gera débito de carcaça)</label>`;
			const selectable = omieOn && canApprove;
			const omieCell = (row) => {
				const [tone, label] = OMIE_STATUS[row.omieStatus || "none"] || OMIE_STATUS.none;
				const extra =
					row.omieStatus === "error"
						? `<br><small class="feedback">${esc(row.omieError || "")}</small>${row.omieNextAttemptAt ? `<br><small class="muted">Nova tentativa automática ${esc(PP.formatDateTime(row.omieNextAttemptAt))}</small>` : ""}`
						: "";
				return `<span class="table-status ${tone}">${label}</span>${extra}`;
			};
			const omieActions = (row) => {
				if (!selectable || !row.active) return "";
				if (row.omieStatus === "error")
					return `<button class="button button-secondary compact-button" type="button" data-omie-retry="${esc(row.id)}">Reenviar ao Omie</button>`;
				if (!row.omieStatus || row.omieStatus === "pending_approval")
					return `<button class="button button-primary compact-button" type="button" data-omie-approve="${esc(row.id)}">${row.omieStatus ? "Aprovar e enviar" : "Enviar ao Omie"}</button>`;
				return "";
			};
			const canSelect = (row) => selectable && row.active && (!row.omieStatus || row.omieStatus === "pending_approval");
			set(
				`<nav class="tabs" role="tablist"><button role="tab" class="${isCustomers ? "active" : ""}" data-tab="customers">Clientes</button><button role="tab" class="${isCustomers ? "" : "active"}" data-tab="products">Produtos</button></nav>${section(
					isCustomers ? "Clientes" : "Produtos",
					isCustomers ? "Cadastro de clientes" : "Cadastro de produtos",
					`<form id="registry-form" class="create-user-form" novalidate><div class="editor-grid">${isCustomers ? `<label>Nome ou razão social<input name="name" required maxlength="180" /></label><label>CPF ou CNPJ<input name="document" /></label><label>E-mail<input name="email" type="email" /></label><label>Telefone<input name="phone" /></label>${repSelect("")}` : `<label>Código<input name="code" required maxlength="80" /></label><label>Descrição<input name="description" required maxlength="180" /></label>${omieOn ? `<label>Unidade (Omie)<select name="unit" required><option value="">Escolha</option>${unitOptions("")}</select></label><label>Valor de referência (opcional)<input name="referencePrice" inputmode="decimal" placeholder="0,00" /></label>` : ""}`}</div>${isCustomers ? "" : remanufacturedBox(false)}${omieOn ? '<p class="muted">A peça nova fica <strong>Aguardando aprovação</strong>. Gerente, supervisor ou administrador informa o NCM e envia ao Omie.</p>' : ""}<div class="form-actions"><p id="registry-feedback" class="feedback" role="alert"></p><button class="button button-primary" type="submit">Cadastrar</button></div></form><div class="inline-form my-12"><label>Buscar<input id="registry-search" type="search" value="${esc(q)}" placeholder="${isCustomers ? "Nome ou documento" : "Código ou descrição"}" /></label>${
						omieOn
							? `<label>Situação no Omie<select id="registry-omie-filter"><option value="">Todas</option>${Object.entries(OMIE_STATUS)
									.map(([key, [, label]]) => `<option value="${key}" ${key === omieFilter ? "selected" : ""}>${label}</option>`)
									.join("")}</select></label>`
							: ""
					}${selectable ? `<button class="button button-primary compact-button" type="button" id="omie-batch" ${selectedProducts.size ? "" : "disabled"}>Aprovar e enviar selecionadas${selectedProducts.size ? ` (${selectedProducts.size})` : ""}</button>` : ""}</div>${table(
						isCustomers
							? ["Nome", "CPF/CNPJ", "E-mail", "Telefone", "Representante", "Status", ""]
							: [...(selectable ? [""] : []), "Código", "Descrição", "Carcaça", ...(omieOn ? ["Unidade", "NCM", "Omie"] : []), "Status", ""],
						rows.map(
							(row) =>
								`<tr>${isCustomers ? `<td><strong>${esc(row.name)}</strong></td><td>${esc(PP.maskDocument(row.document || ""))}</td><td>${esc(row.email || "")}</td><td>${esc(row.phone || "")}</td><td>${esc(row.representativeName || "—")}</td>` : `${selectable ? `<td>${canSelect(row) ? `<input type="checkbox" data-select-product="${esc(row.id)}" aria-label="Selecionar ${esc(row.code)}" ${selectedProducts.has(row.id) ? "checked" : ""} />` : ""}</td>` : ""}<td><strong>${esc(row.code)}</strong></td><td>${esc(row.description)}</td><td>${row.remanufactured ? '<span class="table-status blue">Remanufaturada</span>' : "—"}</td>${omieOn ? `<td>${esc(row.unit || "—")}</td><td>${esc(row.ncm || "—")}</td><td>${omieCell(row)}</td>` : ""}`}<td><span class="table-status ${row.active ? "green" : "red"}">${row.active ? "Ativo" : "Inativo"}</span></td><td><div class="actions-cell">${isCustomers ? "" : omieActions(row)}${canManage ? `<button class="button button-secondary compact-button" type="button" data-edit="${esc(row.id)}">Editar</button><button class="button button-secondary compact-button" type="button" data-active="${esc(row.id)}" data-value="${!row.active}">${row.active ? "Inativar" : "Reativar"}</button>` : ""}</div></td></tr>`
						),
						"Nada cadastrado ainda."
					)}`
				)}`
			);
			content()
				.querySelectorAll("[data-tab]")
				.forEach((button) =>
					button.addEventListener("click", () => {
						tab = button.dataset.tab;
						render();
					})
				);
			const form = document.querySelector("#registry-form");
			if (form.elements.document) PP.bindDocumentInput(form.elements.document);
			form.addEventListener("submit", async (event) => {
				event.preventDefault();
				PP.clearFieldErrors(form);
				try {
					await api.post(`/api/${tab}`, Object.fromEntries(new FormData(form)));
					PP.toast("Cadastrado.", "success");
					render();
				} catch (error) {
					if (!PP.applyServerErrors(form, error)) document.querySelector("#registry-feedback").textContent = error.message;
				}
			});
			document.querySelector("#registry-search").addEventListener(
				"input",
				PP.debounce(async () => {
					const value = document.querySelector("#registry-search").value;
					await render();
					const input = document.querySelector("#registry-search");
					input.focus();
					input.setSelectionRange(value.length, value.length);
				}, 350)
			);
			content()
				.querySelectorAll("[data-active]")
				.forEach((button) =>
					button.addEventListener("click", async () => {
						try {
							await api.patch(`/api/${tab}/${button.dataset.active}`, { active: button.dataset.value === "true" });
							render();
						} catch (error) {
							PP.toast(error.message, "error");
						}
					})
				);
			content()
				.querySelectorAll("[data-edit]")
				.forEach((button) =>
					button.addEventListener("click", async () => {
						const row = rows.find((entry) => String(entry.id) === button.dataset.edit);
						const body = isCustomers
							? `<label>Nome<input name="name" value="${esc(row.name)}" required /></label><label>CPF ou CNPJ<input name="document" value="${esc(PP.formatDocument(row.document || ""))}" /></label><label>E-mail<input name="email" value="${esc(row.email || "")}" /></label><label>Telefone<input name="phone" value="${esc(row.phone || "")}" /></label>${repSelect(row.representativeId)}`
							: `<label>Código<input name="code" value="${esc(row.code)}" required /></label><label>Descrição<input name="description" value="${esc(row.description)}" required /></label>${omieOn ? `<label>Unidade<select name="unit"><option value="">—</option>${unitOptions(row.unit)}</select></label><label>NCM<input name="ncm" data-ncm inputmode="numeric" placeholder="0000.00.00" value="${esc(row.ncm || "")}" /></label><label>Valor de referência<input name="referencePrice" inputmode="decimal" value="${row.referencePrice ? esc(String(row.referencePrice).replace(".", ",")) : ""}" /></label>` : ""}${remanufacturedBox(row.remanufactured)}`;
						setTimeout(() => bindNcmInputs(document), 0);
						const answer = await PP.dialog({ title: "Editar cadastro", body, confirmLabel: "Salvar" });
						if (!answer) return;
						if (!isCustomers && "referencePrice" in answer) answer.referencePrice = answer.referencePrice ? PP.parseMoney(answer.referencePrice) : null;
						if (!isCustomers && answer.unit === "") delete answer.unit;
						if (!isCustomers) answer.remanufactured = answer.remanufactured === "true";
						try {
							await api.patch(`/api/${tab}/${row.id}`, answer);
							PP.toast("Atualizado.", "success");
							render();
						} catch (error) {
							PP.toast(error.message, "error");
						}
					})
				);
			if (!isCustomers) bindOmie(rows);
		};
		// Aprovar e enviar (uma ou varias): quem aprova informa o NCM de cada peca e confere a unidade.
		const approveDialog = async (items) => {
			const body = `<p class="muted">Confira a unidade e informe o NCM (8 dígitos). As peças vão para o Omie com o mesmo código; se o código já existir lá, os cadastros só são ligados.</p>${items
				.map(
					(row) =>
						`<fieldset class="plain-fieldset"><legend><strong>${esc(row.code)}</strong> · ${esc(row.description)}</legend><div class="editor-grid"><label>Unidade<select name="unit-${row.id}" required>${unitOptions(row.unit || "UN")}</select></label><label>NCM<input name="ncm-${row.id}" data-ncm required inputmode="numeric" placeholder="0000.00.00" pattern="[0-9]{4}[.][0-9]{2}[.][0-9]{2}" title="8 dígitos: 0000.00.00" value="${esc(row.ncm || "")}" /></label></div></fieldset>`
				)
				.join("")}`;
			setTimeout(() => bindNcmInputs(document), 0);
			const answer = await PP.dialog({
				title: items.length > 1 ? `Aprovar e enviar ${items.length} peças ao Omie` : "Aprovar e enviar ao Omie",
				body,
				confirmLabel: "Aprovar e enviar"
			});
			if (!answer) return;
			try {
				const result = await api.post("/api/omie/products/approve", {
					items: items.map((row) => ({ id: row.id, ncm: answer[`ncm-${row.id}`], unit: answer[`unit-${row.id}`] }))
				});
				const problems = result.results.filter((entry) => entry.status === "error");
				PP.toast(
					problems.length
						? `${result.queued} enviada(s). ${problems.map((entry) => `${entry.code || entry.id}: ${entry.message}`).join(" ")}`
						: `${result.queued} peça(s) a caminho do Omie.`,
					problems.length ? "error" : "success"
				);
				selectedProducts.clear();
				pollCount = 0;
				await render();
			} catch (error) {
				PP.toast(error.message, "error");
			}
		};
		function bindOmie(rows) {
			const byId = new Map(rows.map((row) => [String(row.id), row]));
			document.querySelector("#registry-omie-filter")?.addEventListener("change", () => {
				selectedProducts.clear();
				render();
			});
			content()
				.querySelectorAll("[data-select-product]")
				.forEach((box) =>
					box.addEventListener("change", () => {
						const id = Number(box.dataset.selectProduct);
						if (box.checked) selectedProducts.add(id);
						else selectedProducts.delete(id);
						const batch = document.querySelector("#omie-batch");
						batch.disabled = !selectedProducts.size;
						batch.textContent = `Aprovar e enviar selecionadas${selectedProducts.size ? ` (${selectedProducts.size})` : ""}`;
					})
				);
			document.querySelector("#omie-batch")?.addEventListener("click", () => {
				const items = [...selectedProducts].map((id) => byId.get(String(id))).filter(Boolean);
				if (items.length) approveDialog(items);
			});
			content()
				.querySelectorAll("[data-omie-approve]")
				.forEach((button) => button.addEventListener("click", () => approveDialog([byId.get(button.dataset.omieApprove)])));
			content()
				.querySelectorAll("[data-omie-retry]")
				.forEach((button) =>
					button.addEventListener("click", async () => {
						button.disabled = true;
						try {
							const result = await api.post(`/api/omie/products/${button.dataset.omieRetry}/retry`, {});
							const failed = result.results.find((entry) => entry.status === "error");
							PP.toast(failed ? failed.message : "Reenvio iniciado.", failed ? "error" : "success");
							pollCount = 0;
							await render();
						} catch (error) {
							PP.toast(error.message, "error");
							button.disabled = false;
						}
					})
				);
			// Enquanto houver envio em andamento, atualiza a lista sozinha (ate ~1 min).
			if (rows.some((row) => row.omieStatus === "sending") && pollCount < 15) {
				pollCount += 1;
				setTimeout(() => {
					if (document.querySelector("#registry-form") && tab === "products") render();
				}, 4000);
			}
		}
		await render();
	}

	// ------------------------------------------------------- Importacao em lote
	const IMPORT_COLUMNS = [
		"type",
		"client",
		"clientDocument",
		"product",
		"productCode",
		"quantity",
		"documentReference",
		"notes",
		"exchangeReason",
		"itemCondition",
		"unitPrice"
	];
	function parseCsv(text) {
		const separator = (text.split("\n")[0].match(/;/g) || []).length >= (text.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
		const rows = [];
		let row = [];
		let cell = "";
		let quoted = false;
		for (let index = 0; index < text.length; index += 1) {
			const char = text[index];
			if (quoted) {
				if (char === '"' && text[index + 1] === '"') {
					cell += '"';
					index += 1;
				} else if (char === '"') quoted = false;
				else cell += char;
			} else if (char === '"') quoted = true;
			else if (char === separator) {
				row.push(cell);
				cell = "";
			} else if (char === "\n") {
				row.push(cell.replace(/\r$/, ""));
				rows.push(row);
				row = [];
				cell = "";
			} else cell += char;
		}
		if (cell || row.length) {
			row.push(cell.replace(/\r$/, ""));
			rows.push(row);
		}
		return rows.filter((entry) => entry.some((value) => value.trim()));
	}
	async function importPage() {
		set(
			section(
				"Lote",
				"Importar pedidos e processos",
				`<p class="muted">Envie um arquivo CSV (separador ; ou ,) com as colunas: <code>${IMPORT_COLUMNS.join(", ")}</code>. Máximo de 500 linhas. Base de troca exige <em>exchangeReason</em> e <em>itemCondition</em>.</p><div class="inline-form"><label>Arquivo CSV<input type="file" id="import-file" accept=".csv,text/csv" /></label><button class="button button-secondary compact-button" type="button" id="import-template">Baixar modelo</button></div><div id="import-preview" class="mt-16"></div>`
			)
		);
		document.querySelector("#import-template").addEventListener("click", () => {
			const blob = new Blob([`\ufeff${IMPORT_COLUMNS.join(";")}\nPedido de venda;Oficina Central;;Válvula 5/2 vias;VL-52;2;NF-1001;;;;150,00\n`], {
				type: "text/csv"
			});
			const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "modelo-importacao.csv" });
			link.click();
			URL.revokeObjectURL(link.href);
		});
		document.querySelector("#import-file").addEventListener("change", async (event) => {
			const file = event.target.files[0];
			if (!file) return;
			const rows = parseCsv(await file.text());
			const header = rows.shift()?.map((name) => name.trim().replace(/^\ufeff/, "")) || [];
			const missing = ["type", "client", "product", "productCode", "quantity"].filter((name) => !header.includes(name));
			const preview = document.querySelector("#import-preview");
			if (missing.length) {
				preview.innerHTML = `<p class="feedback">Colunas obrigatórias ausentes: ${esc(missing.join(", "))}.</p>`;
				return;
			}
			const items = rows.slice(0, 500).map((cells) => {
				const item = {};
				header.forEach((name, index) => {
					const value = (cells[index] || "").trim();
					if (value && IMPORT_COLUMNS.includes(name)) item[name] = name === "quantity" ? Number(value) : name === "unitPrice" ? PP.parseMoney(value) : value;
				});
				return item;
			});
			preview.innerHTML = `<p><strong>${items.length}</strong> linha(s) prontas${rows.length > 500 ? " (somente as 500 primeiras serão enviadas)" : ""}.</p>${table(
				["#", "Tipo", "Cliente", "Produto", "Código", "Qtd"],
				items
					.slice(0, 10)
					.map(
						(item, index) =>
							`<tr><td>${index + 1}</td><td>${esc(item.type)}</td><td>${esc(item.client)}</td><td>${esc(item.product)}</td><td>${esc(item.productCode)}</td><td>${esc(item.quantity)}</td></tr>`
					)
			)}<div class="form-actions"><button class="button button-primary" type="button" id="import-run">Importar ${items.length} processo(s)</button></div><div id="import-result"></div>`;
			document.querySelector("#import-run").addEventListener("click", async (click) => {
				click.currentTarget.disabled = true;
				try {
					const result = await api.post("/api/cases/import", { items });
					document.querySelector("#import-result").innerHTML =
						`<p><strong>${result.created}</strong> criado(s), <strong>${result.errors}</strong> com erro.</p>${
							result.errors
								? table(
										["Linha", "Problema"],
										result.results
											.filter((entry) => entry.status === "error")
											.map((entry) => `<tr><td>${esc(entry.line + 1)}</td><td>${esc(entry.message)}</td></tr>`)
									)
								: ""
						}`;
					PP.toast(`${result.created} processo(s) importado(s).`, result.errors ? "info" : "success");
				} catch (error) {
					document.querySelector("#import-result").innerHTML = `<p class="feedback">${esc(error.message)}</p>`;
					click.currentTarget.disabled = false;
				}
			});
		});
	}

	// ------------------------------------------------- Pedidos e NF-e do Omie
	// Nada e criado sozinho: a pessoa escolhe os registros e o tipo de processo.
	async function omiePage() {
		let status = await api.get("/api/omie/mirror").catch(() => ({ configured: false }));
		if (!status.configured) {
			set(section("ERP", "Omie", '<p class="feedback">Integração não configurada: defina OMIE_APP_KEY e OMIE_APP_SECRET no servidor.</p>'));
			return;
		}
		const today = new Date();
		const iso = (date) => date.toISOString().slice(0, 10);
		const monthAgo = new Date(today.getTime() - 30 * 86400000);
		const state = { kind: "orders", page: null, selected: new Map(), rows: [] };
		set(`<nav class="tabs" role="tablist" aria-label="Origem no Omie"><button class="active" role="tab" aria-selected="true" data-kind="orders">Pedidos de venda</button><button role="tab" aria-selected="false" data-kind="invoices">Notas fiscais (NF-e)</button></nav>
		<form id="omie-filters" class="history-filters panel"><label>De<input name="from" type="date" value="${iso(monthAgo)}" /></label><label>Até<input name="to" type="date" value="${iso(today)}" /></label><label data-invoice-only hidden>Notas<select name="type"><option value="todas">Entrada e saída</option><option value="saida">Saída</option><option value="entrada">Entrada (devoluções)</option></select></label><div class="filter-actions"><button class="button button-primary" type="submit">Filtrar</button></div></form>
		<div class="omie-sync-bar panel" id="omie-sync" role="status" aria-live="polite"></div>
		<section class="panel"><div class="panel-heading"><div><p class="eyebrow">Seleção</p><h2 id="omie-list-title">Pedidos de venda</h2></div><div class="actions-cell"><label>Abrir como<select id="omie-case-type"><option>Pedido de venda</option><option>Base de troca</option><option>Garantia</option></select></label><button class="button button-primary compact-button" type="button" id="omie-import" disabled>Abrir processos</button></div></div><p class="muted">Os mais recentes aparecem primeiro. Marque até 20 registros por vez; o que já virou processo aparece com o número e não pode ser marcado de novo.</p><div id="omie-list" aria-live="polite"></div><div id="omie-pager" class="form-actions"></div><div id="omie-result"></div></section>`);
		const form = document.querySelector("#omie-filters");
		const importButton = document.querySelector("#omie-import");
		const refreshButton = () => {
			importButton.disabled = !state.selected.size;
			importButton.textContent = state.selected.size ? `Abrir ${state.selected.size} processo(s)` : "Abrir processos";
		};
		const brl = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
		// Barra de situacao: os dados vem do espelho local; o Omie avisa as mudancas (webhook) e a cada
		// poucos minutos o servidor busca o que mudou. A tela confere a cada 30 s e se atualiza sozinha.
		const ago = (value) => {
			if (!value) return "nunca";
			const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
			return minutes < 1 ? "agora há pouco" : minutes < 60 ? `há ${minutes} min` : PP.formatDateTime(value);
		};
		const renderSync = () => {
			const info = status[state.kind] || {};
			document.querySelector("#omie-sync").innerHTML =
				`<span class="omie-sync-dot ${status.syncing ? "busy" : status.webhook ? "live" : ""}" aria-hidden="true"></span><span><strong>${status.syncing ? "Atualizando com o Omie…" : status.webhook ? "Em tempo real com o Omie" : "Atualização automática"}</strong> · ${esc(info.count || 0)} registro(s) no app · última busca ${esc(ago(info.lastSyncAt))}${status.webhook ? ` · último aviso do Omie ${esc(ago(status.lastWebhookAt))}` : ""}</span><button class="chip" type="button" id="omie-refresh" ${status.syncing ? "disabled" : ""}>Atualizar agora</button>`;
			document.querySelector("#omie-refresh").addEventListener("click", refreshNow);
		};
		let lastChange = null;
		const pollStatus = async () => {
			if (!document.querySelector("#omie-sync")) return clearInterval(pollTimer);
			if (document.hidden) return;
			try {
				status = await api.get("/api/omie/mirror");
				renderSync();
				const changed = status[state.kind]?.lastChangeAt;
				if (lastChange && changed && changed !== lastChange && !state.selected.size) await load(true);
				lastChange = changed;
			} catch {
				/* sem conexao: tenta no proximo ciclo */
			}
		};
		const pollTimer = setInterval(pollStatus, 30000);
		async function refreshNow() {
			const button = document.querySelector("#omie-refresh");
			button.disabled = true;
			button.textContent = "Atualizando…";
			try {
				const answer = await api.post("/api/omie/mirror/refresh", { kind: state.kind });
				if (answer.running) PP.toast(answer.message, "info");
				else if (answer.recent) PP.toast(answer.message, "info");
				else PP.toast(`Atualizado: ${answer.result.created} novo(s), ${answer.result.updated} alterado(s).`, "success");
				await load(true);
			} catch (error) {
				PP.toast(error.message, "error");
			}
			await pollStatus();
		}
		const render = (data) => {
			const list = document.querySelector("#omie-list");
			const rows = state.kind === "orders" ? data.orders : data.invoices;
			state.rows = rows;
			const statusOf = (row) => {
				if (row.cases.length)
					return `<span class="table-status green">${row.cases.map((number) => `<a class="table-link" href="/caso.html?id=${encodeURIComponent(number)}">${esc(number)}</a>`).join(", ")}</span>`;
				if (row.cancelled) return '<span class="table-status red">Cancelado</span>';
				if (row.isReturn) return '<span class="table-status orange">Devolução</span>';
				if (state.kind === "orders") return `<span class="table-status">${row.invoiced ? "Faturado" : "Em aberto"}</span>`;
				return `<span class="table-status">${row.type === "entrada" ? "Entrada" : "Saída"}</span>`;
			};
			list.innerHTML = table(
				["", state.kind === "orders" ? "Pedido" : "Nota", "Data", "Cliente", "Itens", "Total", "Situação"],
				rows.map((row) => {
					const blocked = row.cases.length > 0 || row.cancelled;
					const label = state.kind === "orders" ? `Pedido ${row.number}` : `NF ${row.number}${row.series ? `/${row.series}` : ""}`;
					return `<tr${row.isReturn ? ' class="row-highlight"' : ""}><td><input type="checkbox" data-ref="${esc(row.ref)}" aria-label="Selecionar ${esc(label)}" ${blocked ? "disabled" : ""} ${state.selected.has(row.ref) ? "checked" : ""} /></td><td><strong>${esc(label)}</strong></td><td>${esc(row.date)}</td><td>${esc(row.customerName || "—")}${row.customerName ? "" : '<br><small class="muted">Cliente não sincronizado</small>'}</td><td>${esc(row.items.length)}<br><small class="muted">${esc(
						row.items
							.slice(0, 2)
							.map((item) => item.description)
							.join("; ")
					)}${row.items.length > 2 ? "…" : ""}</small></td><td>${esc(brl(row.total))}</td><td>${statusOf(row)}</td></tr>`;
				}),
				"Nada encontrado no período."
			);
			list.querySelectorAll("[data-ref]").forEach((box) =>
				box.addEventListener("change", () => {
					if (box.checked && state.selected.size >= 20) {
						box.checked = false;
						PP.toast("No máximo 20 por vez.", "info");
						return;
					}
					if (box.checked) state.selected.set(box.dataset.ref, true);
					else state.selected.delete(box.dataset.ref);
					refreshButton();
				})
			);
			const pager = document.querySelector("#omie-pager");
			pager.innerHTML =
				({
					live: '<span class="muted">Primeira carga do Omie em andamento: mostrando os mais recentes direto do Omie. Em alguns minutos a lista completa fica disponível aqui.</span>',
					loading:
						'<span class="muted">Primeira carga do Omie em andamento: mostrando o que já chegou (os mais recentes vêm primeiro). A lista se completa sozinha.</span>',
					waiting: `<span class="muted">O Omie pediu um pequeno intervalo entre consultas. A lista aparece sozinha em ${esc(data.retryAfter)} s.</span>`
				}[data.source] || "") +
				(data.totalPages > 1
					? `<span class="muted">Página ${data.page} de ${data.totalPages} · ${data.total} registro(s)</span><button class="button button-secondary compact-button" type="button" data-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>Mais recentes</button><button class="button button-secondary compact-button" type="button" data-page="${data.page + 1}" ${data.page >= data.totalPages ? "disabled" : ""}>Mais antigos</button>`
					: `<span class="muted">${data.total} registro(s)</span>`);
			pager.querySelectorAll("[data-page]").forEach((button) =>
				button.addEventListener("click", () => {
					state.page = Number(button.dataset.page);
					load();
				})
			);
		};
		const load = async (quiet = false) => {
			const list = document.querySelector("#omie-list");
			if (!list) return;
			if (!quiet) list.innerHTML = PP.skeleton(4);
			const params = new URLSearchParams({ from: form.from.value, to: form.to.value });
			if (state.page) params.set("page", state.page);
			if (state.kind === "invoices") params.set("type", form.type.value);
			try {
				const data = await api.get(`/api/omie/${state.kind}?${params}`);
				render(data);
				// Enquanto a carga inicial roda (ou o Omie pede intervalo), a tela se recarrega sozinha.
				clearTimeout(state.retryTimer);
				if (["live", "loading", "waiting"].includes(data.source)) {
					const kind = state.kind;
					state.retryTimer = setTimeout(
						() => {
							if (state.kind === kind && !state.selected.size && document.querySelector("#omie-list")) load(true);
						},
						(data.source === "waiting" ? data.retryAfter : 20) * 1000
					);
				}
			} catch (error) {
				list.innerHTML = PP.errorState(error.message);
				list.querySelector("[data-retry]")?.addEventListener("click", load);
			}
		};
		content()
			.querySelectorAll("[data-kind]")
			.forEach((tab) =>
				tab.addEventListener("click", () => {
					state.kind = tab.dataset.kind;
					state.page = null;
					state.selected.clear();
					refreshButton();
					content()
						.querySelectorAll("[data-kind]")
						.forEach((other) => {
							other.classList.toggle("active", other === tab);
							other.setAttribute("aria-selected", String(other === tab));
						});
					content().querySelector("[data-invoice-only]").hidden = state.kind !== "invoices";
					document.querySelector("#omie-list-title").textContent = state.kind === "orders" ? "Pedidos de venda" : "Notas fiscais";
					document.querySelector("#omie-case-type").value = state.kind === "orders" ? "Pedido de venda" : "Base de troca";
					lastChange = null;
					renderSync();
					load();
				})
			);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			state.page = null;
			load();
		});
		importButton.addEventListener("click", async () => {
			const type = document.querySelector("#omie-case-type").value;
			const refs = [...state.selected.keys()];
			const confirmed = await PP.dialog({
				title: "Abrir processos a partir do Omie",
				body: `<p>Serão abertos <strong>${refs.length}</strong> processo(s) do tipo <strong>${esc(type)}</strong>, já validados, com cliente, produto e documento de origem preenchidos.</p>`,
				confirmLabel: "Abrir processos"
			});
			if (!confirmed) return;
			importButton.disabled = true;
			const result = document.querySelector("#omie-result");
			try {
				const data = await api.post("/api/omie/import", { kind: state.kind, type, refs });
				result.innerHTML = table(
					["Registro", "Resultado"],
					data.results.map(
						(entry) =>
							`<tr><td>${esc(entry.ref)}</td><td>${entry.status === "created" ? `<span class="table-status green">Criado</span> <a class="table-link" href="/caso.html?id=${encodeURIComponent(entry.caseNumber)}">${esc(entry.caseNumber)}</a>` : `<span class="table-status ${entry.status === "skipped" ? "orange" : "red"}">${entry.status === "skipped" ? "Já existia" : "Erro"}</span> ${esc(entry.message)}`}</td></tr>`
					)
				);
				PP.toast(`${data.created} processo(s) aberto(s).`, data.created === refs.length ? "success" : "info");
				state.selected.clear();
				refreshButton();
				await load();
			} catch (error) {
				result.innerHTML = `<p class="feedback">${esc(error.message)}</p>`;
				refreshButton();
			}
		});
		renderSync();
		lastChange = status[state.kind]?.lastChangeAt || null;
		await load();
	}

	// ------------------------------------------------- Controle de carcacas (base de troca)
	// O cliente recebe a peca remanufaturada e fica devendo a carcaca. Saldo por cliente e por representante;
	// devolucao aproveitavel abate, refugada so fica registrada; prazo padrao configuravel.
	const CARCASS_KINDS = { debit: ["orange", "Saída (deve)"], return: ["green", "Devolução"], adjustment: ["blue", "Ajuste"] };
	const formatDate = (value) => (value ? value.split("-").reverse().join("/") : "—");
	const todayIsoDate = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

	async function carcassPage() {
		const canManage = PP.can("carcass.manage");
		const canReverse = PP.can("carcass.reverse");
		const canRegistry = PP.can("registry.manage");
		const state = { view: "customer", q: "", representativeId: "", overdue: false, all: false, entriesPage: 1, entriesCustomer: null, expanded: new Set() };
		let representatives = [];
		let config = { dueDays: 30, omieStart: null, canEdit: false };

		const loadRepresentatives = async () => {
			representatives = (await api.get("/api/representatives?includeInactive=true")).representatives;
		};
		const repOptions = (selected, emptyLabel) =>
			`<option value="">${esc(emptyLabel)}</option>${representatives
				.filter((rep) => rep.active || String(rep.id) === String(selected))
				.map(
					(rep) =>
						`<option value="${esc(rep.id)}" ${String(rep.id) === String(selected) ? "selected" : ""}>${esc(rep.name)}${rep.code ? ` (${esc(rep.code)})` : ""}</option>`
				)
				.join("")}`;

		set(`<section class="indicator-grid report-cards" id="carcass-cards">${PP.skeleton(1)}</section>
			${canManage ? `<div class="carcass-actions"><button class="button button-primary" type="button" data-carcass-new="debit">+ Registrar saída (cliente deve)</button><button class="button button-secondary" type="button" data-carcass-new="return">Registrar devolução de carcaça</button><button class="button button-secondary" type="button" data-carcass-new="adjustment">Ajuste</button></div>` : ""}
			<nav class="tabs" role="tablist" aria-label="Visões do controle de carcaças"><button class="active" role="tab" data-carcass-view="customer">Saldo por cliente</button><button role="tab" data-carcass-view="representative">Saldo por representante</button><button role="tab" data-carcass-view="entries">Lançamentos</button><button role="tab" data-carcass-view="representatives">Representantes</button><button role="tab" data-carcass-view="config">Prazo e Omie</button></nav>
			<div id="carcass-view" aria-live="polite"></div>`);

		async function renderCards() {
			const data = await api.get("/api/carcass/summary");
			document.querySelector("#carcass-cards").innerHTML =
				`${card("Carcaças em aberto", data.totals.outstanding)}${card("Vencidas", data.totals.overdue, "red")}${card("Clientes devendo", data.totals.debtors, "orange")}${card(`Devolvidas no mês${data.totals.refusedThisMonth ? ` (+${data.totals.refusedThisMonth} refugadas)` : ""}`, data.totals.returnedThisMonth, "green")}`;
		}

		// ---- Saldo (por cliente ou por representante)
		async function renderSummary() {
			const host = document.querySelector("#carcass-view");
			const byRep = state.view === "representative";
			const params = new URLSearchParams({ groupBy: state.view });
			if (state.q) params.set("q", state.q);
			if (state.representativeId) params.set("representativeId", state.representativeId);
			if (state.overdue) params.set("overdue", "true");
			if (state.all) params.set("all", "true");
			const data = await api.get(`/api/carcass/summary?${params}`);
			datasets.clear();
			const columns = [
				{ key: "name", header: byRep ? "Representante" : "Cliente" },
				...(byRep ? [{ key: "customerCount", header: "Clientes" }] : [{ key: "representativeName", header: "Representante" }]),
				{ key: "outstanding", header: "Em aberto" },
				{ key: "overdue", header: "Vencidas" },
				{ key: "nextDue", header: "Próximo vencimento" },
				{ key: "debited", header: "Saídas" },
				{ key: "returned", header: "Devolvidas" },
				{ key: "refused", header: "Refugadas" }
			];
			const tools = dataTools(
				byRep ? "Saldo de carcaças por representante" : "Saldo de carcaças por cliente",
				columns,
				data.rows.map((row) => ({ ...row, nextDue: formatDate(row.nextDue) }))
			);
			const lineTable = (row) =>
				`<tr class="carcass-detail"><td colspan="${byRep ? 8 : 8}">${table(
					[...(byRep ? ["Cliente"] : []), "Peça", "Em aberto", "Vencidas", "Próximo vencimento", "Saídas", "Devolvidas", "Refugadas", ""],
					row.lines.map(
						(line) =>
							`<tr>${byRep ? `<td>${esc(line.customerName)}</td>` : ""}<td><strong>${esc(line.productCode)}</strong><br><small class="muted">${esc(line.productDescription || "")}</small></td><td><strong>${esc(line.outstanding)}</strong></td><td>${line.overdue ? `<span class="table-status red">${esc(line.overdue)}</span>` : "0"}</td><td>${esc(formatDate(line.nextDue))}</td><td>${esc(line.debited)}</td><td>${esc(line.returned)}</td><td>${esc(line.refused)}</td><td>${canManage && line.outstanding > 0 && line.customerId ? `<button class="button button-secondary compact-button" type="button" data-carcass-return="${esc(line.customerId)}" data-code="${esc(line.productCode)}" data-name="${esc(line.customerName)}" data-qty="${esc(line.outstanding)}">Registrar devolução</button>` : ""}</td></tr>`
					)
				)}${!byRep && row.customerId ? `<button class="chip" type="button" data-carcass-ledger="${esc(row.customerId)}" data-name="${esc(row.name)}">Ver lançamentos deste cliente</button>` : ""}</td></tr>`;
			host.innerHTML = section(
				byRep ? "Representantes" : "Clientes",
				byRep ? "Carcaças em aberto por representante" : "Carcaças em aberto por cliente",
				`<form id="carcass-filters" class="inline-form my-12"><label>Buscar<input name="q" type="search" value="${esc(state.q)}" placeholder="${byRep ? "Representante" : "Cliente ou representante"}" /></label><label>Representante<select name="representativeId">${repOptions(state.representativeId, "Todos")}</select></label><label class="check-inline"><input type="checkbox" name="overdue" ${state.overdue ? "checked" : ""} /> Só com vencidas</label><label class="check-inline"><input type="checkbox" name="all" ${state.all ? "checked" : ""} /> Incluir quitados</label></form>
				${table(
					[
						byRep ? "Representante" : "Cliente",
						byRep ? "Clientes" : "Representante",
						"Em aberto",
						"Vencidas",
						"Próximo vencimento",
						"Devolvidas",
						"Refugadas",
						""
					],
					data.rows.flatMap((row) => {
						const open = state.expanded.has(String(row.key));
						return [
							`<tr><td><strong>${esc(row.name)}</strong></td><td>${byRep ? esc(row.customerCount) : esc(row.representativeName || "—")}</td><td><strong>${esc(row.outstanding)}</strong></td><td>${row.overdue ? `<span class="table-status red">${esc(row.overdue)} vencida(s)</span>` : '<span class="table-status green">Em dia</span>'}</td><td>${esc(formatDate(row.nextDue))}</td><td>${esc(row.returned)}</td><td>${esc(row.refused)}</td><td><button class="chip" type="button" data-carcass-expand="${esc(row.key)}" aria-expanded="${open}">${open ? "Fechar" : "Detalhar por peça"}</button></td></tr>`,
							open ? lineTable(row) : ""
						];
					}),
					state.all ? "Nenhum lançamento ainda." : "Nenhuma carcaça em aberto."
				)}`,
				tools
			);
			const filters = host.querySelector("#carcass-filters");
			const apply = () => {
				state.q = filters.q.value.trim();
				state.representativeId = filters.representativeId.value;
				state.overdue = filters.overdue.checked;
				state.all = filters.all.checked;
				renderSummary();
			};
			filters.addEventListener("submit", (event) => {
				event.preventDefault();
				apply();
			});
			filters.q.addEventListener("input", PP.debounce(apply, 400));
			[filters.representativeId, filters.overdue, filters.all].forEach((input) => input.addEventListener("change", apply));
			host.querySelectorAll("[data-carcass-expand]").forEach((button) =>
				button.addEventListener("click", () => {
					const key = button.dataset.carcassExpand;
					if (state.expanded.has(key)) state.expanded.delete(key);
					else state.expanded.add(key);
					renderSummary();
				})
			);
			host
				.querySelectorAll("[data-carcass-return]")
				.forEach((button) =>
					button.addEventListener("click", () =>
						openEntry("return", { customerId: button.dataset.carcassReturn, customerName: button.dataset.name, productCode: button.dataset.code, quantity: 1 })
					)
				);
			host.querySelectorAll("[data-carcass-ledger]").forEach((button) =>
				button.addEventListener("click", () => {
					state.entriesCustomer = { id: button.dataset.carcassLedger, name: button.dataset.name };
					state.entriesPage = 1;
					switchView("entries");
				})
			);
		}

		// ---- Lancamentos (livro)
		async function renderEntries() {
			const host = document.querySelector("#carcass-view");
			const params = new URLSearchParams({ page: state.entriesPage });
			if (state.entriesCustomer) params.set("customerId", state.entriesCustomer.id);
			const data = await api.get(`/api/carcass/entries?${params}`);
			datasets.clear();
			const tools = dataTools(
				"Lançamentos de carcaças",
				[
					{ key: "entryDate", header: "Data" },
					{ key: "kindLabel", header: "Tipo" },
					{ key: "customerName", header: "Cliente" },
					{ key: "representativeName", header: "Representante" },
					{ key: "productCode", header: "Peça" },
					{ key: "quantity", header: "Qtd" },
					{ key: "condition", header: "Condição" },
					{ key: "dueDate", header: "Prazo" },
					{ key: "document", header: "Documento" },
					{ key: "origin", header: "Origem" },
					{ key: "status", header: "Situação" }
				],
				data.entries.map((entry) => ({
					...entry,
					entryDate: formatDate(entry.entryDate),
					dueDate: formatDate(entry.dueDate),
					kindLabel: CARCASS_KINDS[entry.kind][1],
					condition: entry.condition === "refugada" ? "Refugada" : entry.condition === "aproveitavel" ? "Aproveitável" : "",
					origin: entry.source === "omie_nf" ? "Omie (NF)" : entry.createdByName || "",
					status: entry.reversedAt ? `Estornado: ${entry.reversalReason || ""}` : "Válido"
				}))
			);
			host.innerHTML = section(
				"Livro",
				state.entriesCustomer ? `Lançamentos de ${state.entriesCustomer.name}` : "Todos os lançamentos",
				`${state.entriesCustomer ? '<p><button class="chip" type="button" id="carcass-ledger-all">Ver todos os clientes</button></p>' : ""}${table(
					["Data", "Tipo", "Cliente", "Peça", "Qtd", "Condição", "Prazo", "Documento", "Origem", ""],
					data.entries.map((entry) => {
						const [tone, label] = CARCASS_KINDS[entry.kind];
						return `<tr${entry.reversedAt ? ' class="row-reversed"' : ""}><td>${esc(formatDate(entry.entryDate))}</td><td><span class="table-status ${tone}">${label}</span></td><td><strong>${esc(entry.customerName)}</strong><br><small class="muted">${esc(entry.representativeName || "Sem representante")}</small></td><td><strong>${esc(entry.productCode)}</strong><br><small class="muted">${esc(entry.productDescription || "")}</small></td><td>${esc(entry.quantity)}</td><td>${entry.condition === "refugada" ? '<span class="table-status red">Refugada</span>' : entry.condition === "aproveitavel" ? "Aproveitável" : "—"}</td><td>${esc(formatDate(entry.dueDate))}</td><td>${esc(entry.document || "—")}${entry.notes ? `<br><small class="muted">${esc(entry.notes)}</small>` : ""}</td><td>${entry.source === "omie_nf" ? "Omie (NF)" : esc(entry.createdByName || "—")}</td><td>${entry.reversedAt ? `<span class="table-status">Estornado</span><br><small class="muted">${esc(entry.reversalReason || "")}</small>` : canReverse ? `<button class="button button-secondary compact-button" type="button" data-carcass-reverse="${esc(entry.id)}">Estornar</button>` : ""}</td></tr>`;
					}),
					"Nenhum lançamento."
				)}<div class="form-actions">${data.totalPages > 1 ? `<span class="muted">Página ${data.page} de ${data.totalPages} · ${data.total} lançamento(s)</span><button class="button button-secondary compact-button" type="button" data-entries-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>Mais recentes</button><button class="button button-secondary compact-button" type="button" data-entries-page="${data.page + 1}" ${data.page >= data.totalPages ? "disabled" : ""}>Mais antigos</button>` : `<span class="muted">${data.total} lançamento(s)</span>`}</div>`,
				tools
			);
			host.querySelector("#carcass-ledger-all")?.addEventListener("click", () => {
				state.entriesCustomer = null;
				state.entriesPage = 1;
				renderEntries();
			});
			host.querySelectorAll("[data-entries-page]").forEach((button) =>
				button.addEventListener("click", () => {
					state.entriesPage = Number(button.dataset.entriesPage);
					renderEntries();
				})
			);
			host.querySelectorAll("[data-carcass-reverse]").forEach((button) =>
				button.addEventListener("click", async () => {
					const answer = await PP.dialog({
						title: "Estornar lançamento",
						body: '<p>O lançamento continua no histórico, mas deixa de contar no saldo.</p><label>Motivo<input name="reason" required minlength="3" maxlength="240" /></label>',
						confirmLabel: "Estornar",
						danger: true
					});
					if (!answer) return;
					try {
						await api.post(`/api/carcass/entries/${button.dataset.carcassReverse}/reverse`, { reason: answer.reason });
						PP.toast("Lançamento estornado.", "success");
						await Promise.all([renderEntries(), renderCards()]);
					} catch (error) {
						PP.toast(error.message, "error");
					}
				})
			);
		}

		// ---- Representantes
		async function renderRepresentatives() {
			const host = document.querySelector("#carcass-view");
			await loadRepresentatives();
			host.innerHTML = section(
				"Cadastro",
				"Representantes",
				`<p class="muted">Defina o representante padrão de cada cliente em <a class="table-link" href="/cadastro-base.html">Clientes e produtos</a>. Cada lançamento herda o representante do cliente e pode ser trocado.</p>${canRegistry ? '<form id="rep-form" class="inline-form my-12" novalidate><label>Nome<input name="name" required maxlength="120" /></label><label>Código<input name="code" maxlength="40" /></label><label>E-mail<input name="email" type="email" /></label><label>Telefone<input name="phone" /></label><button class="button button-primary compact-button" type="submit">Cadastrar</button></form>' : ""}${table(
					["Nome", "Código", "Contato", "Clientes", "Status", ""],
					representatives.map(
						(rep) =>
							`<tr><td><strong>${esc(rep.name)}</strong></td><td>${esc(rep.code || "—")}</td><td>${esc([rep.email, rep.phone].filter(Boolean).join(" · ") || "—")}</td><td>${esc(rep.customerCount)}</td><td><span class="table-status ${rep.active ? "green" : "red"}">${rep.active ? "Ativo" : "Inativo"}</span></td><td>${canRegistry ? `<div class="actions-cell"><button class="button button-secondary compact-button" type="button" data-rep-edit="${esc(rep.id)}">Editar</button><button class="button button-secondary compact-button" type="button" data-rep-active="${esc(rep.id)}" data-value="${!rep.active}">${rep.active ? "Inativar" : "Reativar"}</button></div>` : ""}</td></tr>`
					),
					"Nenhum representante cadastrado."
				)}`
			);
			host.querySelector("#rep-form")?.addEventListener("submit", async (event) => {
				event.preventDefault();
				const form = event.currentTarget;
				if (!form.name.value.trim()) return PP.toast("Informe o nome.", "error");
				try {
					await api.post("/api/representatives", Object.fromEntries(new FormData(form)));
					PP.toast("Representante cadastrado.", "success");
					await renderRepresentatives();
				} catch (error) {
					PP.toast(error.message, "error");
				}
			});
			host.querySelectorAll("[data-rep-active]").forEach((button) =>
				button.addEventListener("click", async () => {
					await api
						.patch(`/api/representatives/${button.dataset.repActive}`, { active: button.dataset.value === "true" })
						.catch((error) => PP.toast(error.message, "error"));
					await renderRepresentatives();
				})
			);
			host.querySelectorAll("[data-rep-edit]").forEach((button) =>
				button.addEventListener("click", async () => {
					const rep = representatives.find((item) => String(item.id) === button.dataset.repEdit);
					const answer = await PP.dialog({
						title: "Editar representante",
						body: `<label>Nome<input name="name" value="${esc(rep.name)}" required /></label><label>Código<input name="code" value="${esc(rep.code || "")}" /></label><label>E-mail<input name="email" value="${esc(rep.email || "")}" /></label><label>Telefone<input name="phone" value="${esc(rep.phone || "")}" /></label>`,
						confirmLabel: "Salvar"
					});
					if (!answer) return;
					try {
						await api.patch(`/api/representatives/${rep.id}`, answer);
						await renderRepresentatives();
					} catch (error) {
						PP.toast(error.message, "error");
					}
				})
			);
		}

		// ---- Prazo e Omie
		async function renderConfig() {
			const host = document.querySelector("#carcass-view");
			config = await api.get("/api/carcass/config");
			host.innerHTML = section(
				"Regras",
				"Prazo de devolução e notas do Omie",
				`<p class="muted">O prazo vale para cada nova saída (dá para mudar em um lançamento específico). Notas fiscais de saída do Omie com peças marcadas como <strong>remanufaturadas</strong> (em Clientes e produtos) geram a saída automaticamente, a partir da data abaixo. Nota cancelada no Omie estorna a saída.</p><form id="carcass-config" class="inline-form" novalidate><label>Prazo padrão (dias)<input name="dueDays" type="number" min="1" max="365" value="${esc(config.dueDays)}" ${config.canEdit ? "" : "disabled"} /></label><label>Notas do Omie a partir de<input name="omieStart" type="date" value="${esc(config.omieStart || "")}" ${config.canEdit ? "" : "disabled"} /></label>${config.canEdit ? '<button class="button button-primary compact-button" type="submit">Salvar</button>' : ""}</form>${config.omieStart ? "" : '<p class="feedback">Sem data: as notas do Omie não geram saídas (só lançamentos manuais).</p>'}${config.canEdit ? "" : '<p class="muted">Somente gerentes e administradores alteram estas regras.</p>'}`
			);
			host.querySelector("#carcass-config").addEventListener("submit", async (event) => {
				event.preventDefault();
				const form = event.currentTarget;
				try {
					await api.put("/api/carcass/config", { dueDays: Number(form.dueDays.value), omieStart: form.omieStart.value || null });
					PP.toast("Regras salvas.", "success");
					await renderConfig();
				} catch (error) {
					PP.toast(error.message, "error");
				}
			});
		}

		// ---- Novo lancamento (saida, devolucao ou ajuste)
		async function openEntry(kind, preset = {}) {
			const titles = { debit: "Registrar saída de peça remanufaturada", return: "Registrar devolução de carcaça", adjustment: "Ajuste de saldo" };
			const hints = {
				debit: `O cliente passa a dever as carcaças. Prazo padrão: ${config.dueDays} dias.`,
				return: "Aproveitável abate o saldo. Refugada fica registrada e o cliente continua devendo.",
				adjustment: "Use quantidade positiva para aumentar o saldo devido e negativa para diminuir. Informe o motivo."
			};
			const body = `<p class="muted">${esc(hints[kind])}</p>
				<label>Cliente<input name="customerName" list="carcass-customer-list" required autocomplete="off" placeholder="Digite 2 letras do nome" value="${esc(preset.customerName || "")}" /></label><datalist id="carcass-customer-list"></datalist><input type="hidden" name="customerId" value="${esc(preset.customerId || "")}" />
				<label>Representante<select name="representativeId">${repOptions("", "Padrão do cliente")}</select></label>
				<label>Código da peça<input name="productCode" list="carcass-product-list" required autocomplete="off" value="${esc(preset.productCode || "")}" /></label><datalist id="carcass-product-list"></datalist>
				<label>Quantidade<input name="quantity" type="number" ${kind === "adjustment" ? "" : 'min="1"'} required value="${esc(preset.quantity || 1)}" /></label>
				${kind === "return" ? '<label>Condição da carcaça<select name="condition" required><option value="aproveitavel">Aproveitável (abate o saldo)</option><option value="refugada">Refugada (não abate)</option></select></label>' : ""}
				<label>Data<input name="entryDate" type="date" value="${todayIsoDate()}" max="${todayIsoDate()}" /></label>
				${kind === "debit" ? `<label>Prazo de devolução (opcional)<input name="dueDate" type="date" /></label>` : ""}
				<label>Documento (NF, pedido)<input name="document" maxlength="120" /></label>
				<label>Observações${kind === "adjustment" ? " (motivo)" : ""}<input name="notes" maxlength="1000" ${kind === "adjustment" ? "required" : ""} /></label>`;
			const customers = new Map();
			setTimeout(() => {
				const modal = document.querySelector(".modal") || document;
				const nameInput = modal.querySelector('[name="customerName"]');
				const idInput = modal.querySelector('[name="customerId"]');
				const codeInput = modal.querySelector('[name="productCode"]');
				if (!nameInput) return;
				nameInput.addEventListener(
					"input",
					PP.debounce(async () => {
						idInput.value = customers.get(nameInput.value)?.id || "";
						if (nameInput.value.trim().length < 2 || idInput.value) return;
						const { customers: found } = await api.get(`/api/customers?limit=20&q=${encodeURIComponent(nameInput.value.trim())}`);
						modal.querySelector("#carcass-customer-list").innerHTML = found
							.map((customer) => {
								customers.set(customer.name, customer);
								return `<option value="${esc(customer.name)}">${esc(PP.maskDocument(customer.document || ""))}${customer.representativeName ? ` · ${esc(customer.representativeName)}` : ""}</option>`;
							})
							.join("");
					}, 250)
				);
				nameInput.addEventListener("change", () => {
					idInput.value = customers.get(nameInput.value)?.id || "";
				});
				codeInput.addEventListener(
					"input",
					PP.debounce(async () => {
						if (codeInput.value.trim().length < 2) return;
						const { products } = await api.get(`/api/products?limit=20&q=${encodeURIComponent(codeInput.value.trim())}`);
						modal.querySelector("#carcass-product-list").innerHTML = products
							.map((product) => `<option value="${esc(product.code)}">${esc(product.description)}${product.remanufactured ? " · remanufaturada" : ""}</option>`)
							.join("");
					}, 250)
				);
			}, 0);
			const answer = await PP.dialog({ title: titles[kind], body, confirmLabel: "Registrar" });
			if (!answer) return;
			if (!answer.customerId) {
				PP.toast("Escolha o cliente na lista de sugestões.", "error");
				return openEntry(kind, { ...preset, ...answer });
			}
			try {
				await api.post("/api/carcass/entries", {
					kind,
					customerId: Number(answer.customerId),
					...(answer.representativeId ? { representativeId: Number(answer.representativeId) } : {}),
					productCode: answer.productCode,
					quantity: Number(answer.quantity),
					condition: answer.condition,
					entryDate: answer.entryDate,
					dueDate: answer.dueDate,
					document: answer.document,
					notes: answer.notes
				});
				PP.toast("Lançamento registrado.", "success");
				await Promise.all([renderCards(), renderCurrent()]);
			} catch (error) {
				PP.toast(error.message, "error");
			}
		}

		const renderCurrent = async () => {
			const host = document.querySelector("#carcass-view");
			try {
				if (state.view === "entries") await renderEntries();
				else if (state.view === "representatives") await renderRepresentatives();
				else if (state.view === "config") await renderConfig();
				else await renderSummary();
			} catch (error) {
				host.innerHTML = PP.errorState(error.message);
				host.querySelector("[data-retry]")?.addEventListener("click", renderCurrent);
			}
		};
		function switchView(view) {
			state.view = view;
			content()
				.querySelectorAll("[data-carcass-view]")
				.forEach((tab) => tab.classList.toggle("active", tab.dataset.carcassView === view));
			document.querySelector("#carcass-view").innerHTML = PP.skeleton(4);
			renderCurrent();
		}
		content()
			.querySelectorAll("[data-carcass-view]")
			.forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.carcassView)));
		content()
			.querySelectorAll("[data-carcass-new]")
			.forEach((button) => button.addEventListener("click", () => openEntry(button.dataset.carcassNew)));

		[config] = await Promise.all([api.get("/api/carcass/config"), loadRepresentatives()]);
		await Promise.all([renderCards(), renderCurrent()]);
	}

	// ------------------------------------------------------------- Guia do app
	async function guidePage() {
		const sections = (window.PPGuide || []).filter((item) => !item.capability || PP.can(item.capability));
		const list = (items, ordered) =>
			items?.length ? `<${ordered ? "ol" : "ul"} class="guide-list">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</${ordered ? "ol" : "ul"}>` : "";
		set(`<div class="guide-layout">
			<nav class="panel guide-toc" aria-label="Índice do guia"><label class="guide-search">Procurar no guia<input type="search" id="guide-filter" placeholder="Ex.: anexar, meta, exportar" autocomplete="off" /></label><ol>${sections.map((item) => `<li><a href="#${esc(item.id)}" data-guide-link="${esc(item.id)}"><span aria-hidden="true">${PP.icon(item.icon)}</span>${esc(item.title)}</a></li>`).join("")}</ol></nav>
			<div class="guide-sections">${sections
				.map(
					(item) =>
						`<section class="panel guide-section" id="${esc(item.id)}" tabindex="-1"><div class="panel-heading"><div><p class="eyebrow">${item.paths?.[0] ? `<a class="table-link" href="${esc(item.paths[0])}">Abrir a tela →</a>` : "Guia"}</p><h2><span class="guide-icon" aria-hidden="true">${PP.icon(item.icon)}</span>${esc(item.title)}</h2></div></div><p>${esc(item.summary)}</p>${item.steps?.length ? `<h3>Como usar</h3>${list(item.steps, true)}` : ""}${item.tips?.length ? `<h3>Dicas</h3>${list(item.tips)}` : ""}${
							item.table
								? table(
										["Perfil", "O que faz"],
										item.table.map(([role, text]) => `<tr><td><strong>${esc(role)}</strong></td><td>${esc(text)}</td></tr>`)
									)
								: ""
						}</section>`
				)
				.join("")}<p id="guide-empty" class="muted" hidden>Nada encontrado. Tente outra palavra.</p></div>
		</div>`);
		const filter = document.querySelector("#guide-filter");
		const normalize = (text) => String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
		filter.addEventListener("input", () => {
			const term = normalize(filter.value.trim());
			let visible = 0;
			document.querySelectorAll(".guide-section").forEach((element) => {
				const show = !term || normalize(element.textContent).includes(term);
				element.hidden = !show;
				document.querySelector(`[data-guide-link="${element.id}"]`).parentElement.hidden = !show;
				visible += show ? 1 : 0;
			});
			document.querySelector("#guide-empty").hidden = visible > 0;
		});
		const focusHash = () => {
			const target = window.location.hash && document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
			document.querySelectorAll("[data-guide-link]").forEach((link) => link.classList.toggle("active", `#${link.dataset.guideLink}` === window.location.hash));
			if (target) {
				target.scrollIntoView({ block: "start" });
				target.focus({ preventScroll: true });
			}
		};
		window.addEventListener("hashchange", focusHash);
		focusHash();
	}

	const pages = {
		omie: omiePage,
		guide: guidePage,
		carcass: carcassPage,
		"reports-builder": reportsBuilder,
		reports,
		"reports-team": teamPerformance,
		"reports-managers": managerPerformance,
		settings: settingsPage,
		account: accountPage,
		users: usersPage,
		notifications: notificationsPage,
		audit: auditPage,
		integrations: integrationsPage,
		registry: registryPage,
		import: importPage
	};
	try {
		me = await PP.requireUser();
		if (!me) return;
		PP.fillProfile(me);
		PP.bindLogout();
		const managersTab = document.querySelector('[data-tab="managers"]');
		if (managersTab && !PP.can("reports.managers.view")) managersTab.remove();
		const builderTab = document.querySelector('[data-tab="builder"]');
		if (builderTab && !PP.can("reports.builder")) builderTab.remove();
		bindDataTools();
		window.PPShellTools?.mount();
		if (pageType === "reports-builder" && !PP.can("reports.builder")) {
			set(section("Acesso", "Construtor de relatórios", '<p class="feedback">Disponível apenas para gerentes e administradores.</p>'));
			return;
		}
		loading();
		await pages[pageType]();
	} catch (error) {
		failure(error, () => window.location.reload());
	}
})();
