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
		`<div class="table-wrap"><table><thead><tr>${heads.map((head) => `<th>${esc(head)}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${heads.length}">${PP.emptyState(empty)}</td></tr>`}</tbody></table></div>`;
	const filterQuery = (form) => {
		const params = new URLSearchParams(new FormData(form));
		[...params.keys()].forEach((key) => {
			if (!params.get(key)) params.delete(key);
		});
		return params.toString();
	};

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
				if (view === "summary") {
					const data = await api.get(`/api/reports/summary?${reportQuery()}`);
					host.innerHTML = `<section class="indicator-grid report-cards">${card("Total de casos", data.totals.total)}${card("Aguardando documento", data.totals.pending, "orange")}${card("Garantias em análise", data.totals.guarantees_in_analysis, "red")}${card("Concluídos", data.totals.completed, "green")}</section>
					<section class="content-grid report-grid"><article class="panel"><div class="panel-heading"><div><p class="eyebrow">Distribuição</p><h2>Casos por tipo</h2></div></div><div class="report-bars">${data.byType.map((item) => `<div class="report-bar"><div><strong>${esc(item.label)}</strong><span>${esc(item.value)}</span></div><i style="width:${Math.max(10, (item.value / Math.max(data.totals.total, 1)) * 100)}%"></i></div>`).join("") || '<p class="muted">Sem dados.</p>'}</div></article>
					<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Prazo</p><h2>Processos vencidos</h2></div><span class="process-status">${data.stalled.length}</span></div>${table(
						["Processo", "Cliente", "Status", "Vencimento"],
						data.stalled
							.slice(0, 10)
							.map(
								(item) =>
									`<tr><td><a class="table-link" href="/caso.html?id=${encodeURIComponent(item.id)}">${esc(item.id)}</a></td><td>${esc(item.client)}</td><td>${esc(PP.statusLabel(item.status))}</td><td>${esc(PP.formatDateTime(item.dueAt))}</td></tr>`
							),
						"Nenhum processo vencido."
					)}</article></section>
					<section class="content-grid report-grid"><article class="panel"><div class="panel-heading"><div><p class="eyebrow">Produtividade</p><h2>Por responsável</h2></div></div>${table(
						["Responsável", "Processos", "Concluídos"],
						data.productivity.map((item) => `<tr><td>${esc(item.user)}</td><td>${esc(item.total)}</td><td>${esc(item.completed)}</td></tr>`)
					)}</article><article class="panel"><div class="panel-heading"><div><p class="eyebrow">Rastreabilidade</p><h2>Eventos recentes</h2></div></div><div class="event-list">${data.events.map((event) => `<div class="event"><span>${esc(event.type)}</span><div><strong>${esc(event.id)} · ${esc(event.description)}</strong><small>${esc(event.responsible)} · ${esc(PP.formatDateTime(event.createdAt))}</small></div></div>`).join("") || '<p class="muted">Sem eventos.</p>'}</div></article></section>`;
				} else if (view === "customer" || view === "product") {
					const data = await api.get(`/api/reports/by-${view}?${reportQuery()}`);
					host.innerHTML = section(
						view === "customer" ? "Clientes" : "Produtos",
						view === "customer" ? "Ocorrências por cliente" : "Reincidência por produto",
						table(
							[view === "customer" ? "Cliente" : "Produto", "Total", "Garantias", "Trocas", "Pedidos", "Peças", "Último movimento"],
							data.rows.map(
								(row) =>
									`<tr><td><strong>${esc(row.label)}</strong>${view === "product" ? `<br><small class="muted">${esc(row.key)}</small>` : ""}</td><td>${esc(row.total)}</td><td>${row.warranties > 1 && view === "product" ? `<span class="table-status red">${esc(row.warranties)} (reincidente)</span>` : esc(row.warranties)}</td><td>${esc(row.exchanges)}</td><td>${esc(row.orders)}</td><td>${esc(row.quantity)}</td><td>${esc(PP.formatDateTime(row.lastAt))}</td></tr>`
							)
						)
					);
				} else if (view === "schedules") {
					await renderSchedules(host);
				} else {
					host.innerHTML = section(
						"Processo",
						"Relatório de um processo",
						'<form id="case-report-form" class="inline-form"><label>Número do processo<input name="id" placeholder="Ex.: GAR-2026-0045" required /></label><button class="button button-primary compact-button" type="submit">Gerar</button></form><div id="case-report" style="margin-top:16px"></div>'
					);
					host.querySelector("#case-report-form").addEventListener("submit", async (event) => {
						event.preventDefault();
						const target = host.querySelector("#case-report");
						target.innerHTML = PP.skeleton(3);
						try {
							const { case: item } = await api.get(`/api/reports/by-case/${encodeURIComponent(event.currentTarget.id.value.trim())}`);
							target.innerHTML = `<div class="kv-grid"><div><small>Processo</small><strong>${esc(item.id)}</strong></div><div><small>Cliente</small><strong>${esc(item.client)}</strong></div><div><small>Tipo</small><strong>${esc(item.type)}</strong></div><div><small>Status</small><strong>${esc(PP.statusLabel(item.status))}</strong></div><div><small>Responsável</small><strong>${esc(item.responsible)}</strong></div><div><small>Prazo</small><strong>${esc(PP.formatDateTime(item.dueAt))}</strong></div></div><h3>Linha do tempo</h3><div class="timeline">${item.events.map((entry) => `<div class="timeline-entry"><strong>${esc(entry.description)}</strong><small>${esc(entry.actorName || entry.responsible)} · ${esc(PP.formatDateTime(entry.createdAt))}</small></div>`).join("")}</div><button class="button button-secondary compact-button" type="button" onclick="window.print()">Imprimir</button>`;
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

	async function teamPerformance() {
		const data = await api.get("/api/reports/team-performance");
		const canGoal = PP.can("settings.manage");
		const teamCards =
			data.teams
				.map(
					(team) =>
						`<article class="panel"><div class="panel-heading"><div><p class="eyebrow">Time</p><h2>${esc(team.managerName)}</h2></div><span class="process-status">${esc(team.partsRegistered)} peças</span></div>${team.managerId && team.monthlyTarget ? `<div class="distribution-row"><div><strong>Meta do mês</strong><span>${esc(team.casesThisMonth)}/${esc(team.monthlyTarget)} processos</span></div><i style="width:${Math.min(100, (team.casesThisMonth / team.monthlyTarget) * 100)}%"></i></div>` : ""}${canGoal && team.managerId ? `<form class="inline-form" data-goal="${esc(team.managerId)}"><label>Meta mensal (processos)<input name="monthlyTarget" type="number" min="1" value="${esc(team.monthlyTarget || "")}" required /></label><button class="button button-secondary compact-button" type="submit">Salvar meta</button></form>` : ""}${table(
							["Integrante", "Perfil", "Processos", "Peças", "No mês"],
							team.members.map(
								(member) =>
									`<tr><td><strong>${esc(member.name)}</strong></td><td>${esc(PP.roleLabel(member.role))}</td><td>${esc(member.casesRegistered)}</td><td>${esc(member.partsRegistered)}</td><td>${esc(member.casesThisMonth)}</td></tr>`
							)
						)}</article>`
				)
				.join("") || PP.emptyState("Nenhum time encontrado");
		set(`<section class="team-performance-grid">${teamCards}</section>`);
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
				`<span class="process-status">${data.managers.length} gerentes</span>`
			)
		);
	}

	// ------------------------------------------------------------- Configuracoes
	async function settingsPage() {
		const [{ settings, sla }, meta] = await Promise.all([api.get("/api/settings"), PP.meta()]);
		const editable = PP.can("settings.manage");
		const toggle = (key, title, hint) =>
			`<label class="setting-row"><span><strong>${esc(title)}</strong><small>${esc(hint)}</small></span><input type="checkbox" data-setting="${esc(key)}" ${settings[key] ? "checked" : ""} ${editable ? "" : "disabled"} /></label>`;
		set(`<section class="settings-grid"><article class="panel"><p class="eyebrow">Operação</p><h2>Configurações do sistema</h2>${editable ? "" : '<p class="muted">Somente gerentes e administradores alteram estas opções.</p>'}${toggle("alerts_enabled", "Alertas de prazo", "Exibir processos vencidos ou perto do vencimento no dashboard")}${toggle("auto_refresh", "Atualização automática", "Atualizar os indicadores do dashboard a cada minuto")}${toggle("require_documents", "Exigir documentação", "Bloquear conclusão e encerramento sem ao menos um anexo")}</article>
		<article class="panel"><p class="eyebrow">Prazos</p><h2>SLA por tipo (dias)</h2><p class="muted">O prazo conta da abertura e fica pausado enquanto o processo aguarda documento.</p>${sla.map((entry) => `<form class="inline-form" data-sla="${esc(entry.type)}"><label>${esc(entry.type)}<input name="days" type="number" min="1" max="365" value="${esc(entry.days)}" ${editable ? "" : "disabled"} required /></label>${editable ? '<button class="button button-secondary compact-button" type="submit">Salvar</button>' : ""}</form>`).join("")}</article>
		<article class="panel"><p class="eyebrow">Padrão operacional</p><h2>Status do fluxo</h2><div class="status-reference">${meta.statuses.map((status) => `<span class="table-status ${PP.statusTone(status.code)}">${esc(status.label)}</span>`).join("")}</div><p class="muted">Cada tipo de processo só permite as transições válidas; decisões (aprovar, improcedente, encerrar) exigem perfil de gerente ou técnico.</p></article></section>`);
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

	async function accountPage() {
		const { user, channels } = await api.get("/api/account");
		const toggle = (name, title, hint, checked, enabled) =>
			`<label class="setting-row"><span><strong>${esc(title)}</strong><small>${esc(hint)}</small></span><input type="checkbox" name="${name}" ${checked ? "checked" : ""} ${enabled ? "" : "disabled"} /></label>`;
		set(
			`<section class="panel account-panel"><p class="eyebrow">Meu acesso</p><h2>Configurações da conta</h2><p class="muted">Atualize seus dados pessoais. O perfil de acesso (${esc(PP.roleLabel(user.role))}) é administrado pelo sistema.</p><form id="account-form" class="form account-form" novalidate><label>Nome<input name="name" value="${esc(user.name)}" required /></label><label>E-mail<input value="${esc(user.email)}" disabled /></label><label>Celular (WhatsApp)<input name="phone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(user.phone || "")}" placeholder="(19) 99999-0000" /></label><label>Nova senha<input name="password" type="password" autocomplete="new-password" placeholder="Deixe em branco para manter a atual" /></label><fieldset class="account-channels"><legend>Onde receber os avisos</legend><p class="muted">Os avisos sempre aparecem no sino do sistema. Marque também os canais externos que quiser.</p>${toggle("notifyEmail", "E-mail", channels.email ? "Prazos, atribuições e menções no seu e-mail." : "Indisponível: o envio de e-mail ainda não foi configurado no servidor.", user.notifyEmail, channels.email)}${toggle("notifyWhatsapp", "WhatsApp", channels.whatsapp ? "Exige o celular preenchido acima. Você pode desligar quando quiser." : "Indisponível: o WhatsApp ainda não foi configurado no servidor.", user.notifyWhatsapp, channels.whatsapp)}</fieldset><button class="button button-primary" type="submit">Salvar alterações <span>→</span></button><p id="account-feedback" class="feedback" role="alert"></p></form></section>`
		);
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
					password: form.password.value,
					phone: form.phone.value,
					notifyEmail: form.notifyEmail.checked,
					notifyWhatsapp: form.notifyWhatsapp.checked
				});
				PP.fillProfile(result.user);
				form.password.value = "";
				feedback.textContent = "";
				PP.toast("Dados atualizados.", "success");
			} catch (error) {
				feedback.textContent = error.message;
			}
		});
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
				`<form id="create-user-form" class="create-user-form" novalidate><div class="editor-grid"><label>Nome<input name="name" required /></label><label>E-mail<input name="email" type="email" required /></label><label>Senha inicial<input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="Ou envie um convite" /></label><label>Perfil<select name="role">${roleOptions}</select></label>${isAdmin ? `<label>Time<select name="managerId">${managerOptions(null)}</select></label>` : ""}</div><label class="inline-check"><input type="checkbox" name="invite" checked /> Enviar convite por e-mail (a pessoa cria a própria senha; o link vale 72 h)</label><div class="form-actions"><p id="create-user-feedback" class="feedback" role="alert"></p><button class="button button-primary" type="submit">Criar conta <span>+</span></button></div></form>${table(
					["Nome", "E-mail", "Perfil", "Time", "Status", "Ação"],
					data.users.map(
						(user) =>
							`<tr><td><strong>${esc(user.name)}</strong></td><td>${esc(user.email)}</td><td>${esc(data.roles[user.role] || user.role)}</td><td>${isAdmin && user.role === "operator" ? `<select data-transfer-user-id="${esc(user.id)}" aria-label="Time de ${esc(user.name)}">${managerOptions(user.managerId)}</select>` : esc(user.managerName || (user.role === "manager" ? "—" : "Sem time"))}</td><td><span class="table-status ${user.active ? "green" : "red"}">${user.active ? "Ativo" : "Bloqueado"}</span></td><td>${user.id === me.id ? "Conta atual" : `<div class="actions-cell"><button class="button button-secondary compact-button" type="button" data-status-user="${esc(user.id)}" data-active="${!user.active}" data-name="${esc(user.name)}">${user.active ? "Bloquear" : "Ativar"}</button>${isAdmin ? `<button class="button button-secondary compact-button" type="button" data-edit-user="${esc(user.id)}">Editar</button><button class="button button-secondary compact-button" type="button" data-reset-user="${esc(user.id)}" data-name="${esc(user.name)}">Redefinir senha</button>` : ""}${user.active ? `<button class="button button-secondary compact-button" type="button" data-invite-user="${esc(user.id)}" data-name="${esc(user.name)}">Reenviar convite</button>` : ""}</div>`}</td></tr>`
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
						body: '<label>Nova senha provisória (mín. 8 caracteres)<input name="password" type="password" minlength="8" autocomplete="new-password" required /></label><p class="muted">As sessões atuais do usuário serão encerradas.</p>',
						confirmLabel: "Redefinir"
					});
					if (!answer) return;
					try {
						await api.post(`/api/users/${button.dataset.resetUser}/reset-password`, { password: answer.password });
						PP.toast("Senha redefinida.", "success");
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
		document.querySelector("#create-user-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = event.currentTarget;
			const button = form.querySelector("button[type=submit]");
			button.disabled = true;
			feedback().textContent = "";
			try {
				const invite = form.invite.checked;
				if (!invite && form.password.value.length < 8) throw new Error("Defina uma senha inicial com 8 caracteres ou marque o envio de convite.");
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

	const AUDIT_LABELS = {
		USER_CREATED: "Usuário criado",
		USER_ACTIVATED: "Usuário ativado",
		USER_DEACTIVATED: "Usuário bloqueado",
		TEAM_TRANSFERRED: "Time alterado",
		USER_UPDATED: "Usuário editado",
		PASSWORD_RESET: "Senha redefinida"
	};
	async function auditPage() {
		const data = await api.get("/api/users/audit");
		set(
			section(
				"Rastreabilidade",
				"Auditoria de usuários",
				table(
					["Quando", "Quem", "Ação", "Usuário afetado", "Detalhes"],
					data.audit.map(
						(item) =>
							`<tr><td>${esc(PP.formatDateTime(item.createdAt))}</td><td>${esc(item.actorName || "—")}</td><td>${esc(AUDIT_LABELS[item.action] || item.action)}</td><td>${esc(item.targetName || "—")}</td><td class="muted">${esc(
								Object.entries(item.details || {})
									.map(([key, value]) => `${key}: ${value}`)
									.join(", ")
							)}</td></tr>`
					),
					"Nenhum registro de auditoria."
				),
				`<span class="process-status">${data.audit.length} registros</span>`
			)
		);
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
					`<form id="webhook-form" class="create-user-form" novalidate><div class="editor-grid"><label>Nome<input name="name" required maxlength="120" /></label><label>Endpoint HTTPS<input name="endpointUrl" type="url" placeholder="https://" required /></label><label>Segredo (assinatura HMAC)<input name="secret" type="password" autocomplete="off" required /></label><fieldset style="border:0;padding:0"><legend style="font-size:11px;font-weight:700">Eventos</legend>${meta.webhookEvents.map((event) => `<label style="display:flex;gap:6px;font-weight:400"><input type="checkbox" name="events" value="${esc(event)}" checked /> ${esc(event)}</label>`).join("")}</fieldset></div><div class="form-actions"><p id="webhook-feedback" class="feedback" role="alert"></p><button class="button button-primary" type="submit">Criar webhook</button></div></form>${table(
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
	async function registryPage() {
		const canManage = PP.can("registry.manage");
		let tab = "customers";
		const render = async () => {
			const isCustomers = tab === "customers";
			const q = document.querySelector("#registry-search")?.value || "";
			const data = await api.get(`/api/${tab}?limit=100&includeInactive=${canManage}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
			const rows = isCustomers ? data.customers : data.products;
			set(
				`<nav class="tabs" role="tablist"><button role="tab" class="${isCustomers ? "active" : ""}" data-tab="customers">Clientes</button><button role="tab" class="${isCustomers ? "" : "active"}" data-tab="products">Produtos</button></nav>${section(
					isCustomers ? "Clientes" : "Produtos",
					isCustomers ? "Cadastro de clientes" : "Cadastro de produtos",
					`<form id="registry-form" class="create-user-form" novalidate><div class="editor-grid">${isCustomers ? '<label>Nome ou razão social<input name="name" required maxlength="180" /></label><label>CPF ou CNPJ<input name="document" /></label><label>E-mail<input name="email" type="email" /></label><label>Telefone<input name="phone" /></label>' : '<label>Código<input name="code" required maxlength="80" /></label><label>Descrição<input name="description" required maxlength="180" /></label>'}</div><div class="form-actions"><p id="registry-feedback" class="feedback" role="alert"></p><button class="button button-primary" type="submit">Cadastrar</button></div></form><div class="inline-form" style="margin:12px 0"><label>Buscar<input id="registry-search" type="search" value="${esc(q)}" placeholder="${isCustomers ? "Nome ou documento" : "Código ou descrição"}" /></label></div>${table(
						isCustomers ? ["Nome", "CPF/CNPJ", "E-mail", "Telefone", "Status", ""] : ["Código", "Descrição", "Status", ""],
						rows.map(
							(row) =>
								`<tr>${isCustomers ? `<td><strong>${esc(row.name)}</strong></td><td>${esc(PP.formatDocument(row.document || ""))}</td><td>${esc(row.email || "")}</td><td>${esc(row.phone || "")}</td>` : `<td><strong>${esc(row.code)}</strong></td><td>${esc(row.description)}</td>`}<td><span class="table-status ${row.active ? "green" : "red"}">${row.active ? "Ativo" : "Inativo"}</span></td><td>${canManage ? `<div class="actions-cell"><button class="button button-secondary compact-button" type="button" data-edit="${esc(row.id)}">Editar</button><button class="button button-secondary compact-button" type="button" data-active="${esc(row.id)}" data-value="${!row.active}">${row.active ? "Inativar" : "Reativar"}</button></div>` : ""}</td></tr>`
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
							? `<label>Nome<input name="name" value="${esc(row.name)}" required /></label><label>CPF ou CNPJ<input name="document" value="${esc(PP.formatDocument(row.document || ""))}" /></label><label>E-mail<input name="email" value="${esc(row.email || "")}" /></label><label>Telefone<input name="phone" value="${esc(row.phone || "")}" /></label>`
							: `<label>Código<input name="code" value="${esc(row.code)}" required /></label><label>Descrição<input name="description" value="${esc(row.description)}" required /></label>`;
						const answer = await PP.dialog({ title: "Editar cadastro", body, confirmLabel: "Salvar" });
						if (!answer) return;
						try {
							await api.patch(`/api/${tab}/${row.id}`, answer);
							PP.toast("Atualizado.", "success");
							render();
						} catch (error) {
							PP.toast(error.message, "error");
						}
					})
				);
		};
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
				`<p class="muted">Envie um arquivo CSV (separador ; ou ,) com as colunas: <code>${IMPORT_COLUMNS.join(", ")}</code>. Máximo de 500 linhas. Base de troca exige <em>exchangeReason</em> e <em>itemCondition</em>.</p><div class="inline-form"><label>Arquivo CSV<input type="file" id="import-file" accept=".csv,text/csv" /></label><button class="button button-secondary compact-button" type="button" id="import-template">Baixar modelo</button></div><div id="import-preview" style="margin-top:16px"></div>`
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
		const status = await api.get("/api/omie/sync").catch(() => ({ configured: false }));
		if (!status.configured) {
			set(section("ERP", "Omie", '<p class="feedback">Integração não configurada: defina OMIE_APP_KEY e OMIE_APP_SECRET no servidor.</p>'));
			return;
		}
		const today = new Date();
		const iso = (date) => date.toISOString().slice(0, 10);
		const monthAgo = new Date(today.getTime() - 30 * 86400000);
		const state = { kind: "orders", page: null, selected: new Map(), rows: [] };
		set(`<nav class="tabs" role="tablist" aria-label="Origem no Omie"><button class="active" role="tab" aria-selected="true" data-kind="orders">Pedidos de venda</button><button role="tab" aria-selected="false" data-kind="invoices">Notas fiscais (NF-e)</button></nav>
		<form id="omie-filters" class="history-filters panel"><label>De<input name="from" type="date" value="${iso(monthAgo)}" /></label><label>Até<input name="to" type="date" value="${iso(today)}" /></label><label data-invoice-only hidden>Notas<select name="type"><option value="todas">Entrada e saída</option><option value="saida">Saída</option><option value="entrada">Entrada (devoluções)</option></select></label><div class="filter-actions"><button class="button button-primary" type="submit">Buscar no Omie</button></div></form>
		<section class="panel"><div class="panel-heading"><div><p class="eyebrow">Seleção</p><h2 id="omie-list-title">Pedidos de venda</h2></div><div class="actions-cell"><label>Abrir como<select id="omie-case-type"><option>Pedido de venda</option><option>Base de troca</option><option>Garantia</option></select></label><button class="button button-primary compact-button" type="button" id="omie-import" disabled>Abrir processos</button></div></div><p class="muted">Os mais recentes aparecem primeiro. Marque até 20 registros por vez; o que já virou processo aparece com o número e não pode ser marcado de novo.</p><div id="omie-list" aria-live="polite"></div><div id="omie-pager" class="form-actions"></div><div id="omie-result"></div></section>`);
		const form = document.querySelector("#omie-filters");
		const importButton = document.querySelector("#omie-import");
		const refreshButton = () => {
			importButton.disabled = !state.selected.size;
			importButton.textContent = state.selected.size ? `Abrir ${state.selected.size} processo(s)` : "Abrir processos";
		};
		const brl = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
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
				data.totalPages > 1
					? `<span class="muted">Página ${data.totalPages - data.page + 1} de ${data.totalPages} · ${data.total} registro(s)</span><button class="button button-secondary compact-button" type="button" data-page="${data.page + 1}" ${data.page >= data.totalPages ? "disabled" : ""}>Mais recentes</button><button class="button button-secondary compact-button" type="button" data-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>Mais antigos</button>`
					: `<span class="muted">${data.total} registro(s)</span>`;
			pager.querySelectorAll("[data-page]").forEach((button) =>
				button.addEventListener("click", () => {
					state.page = Number(button.dataset.page);
					load();
				})
			);
		};
		const load = async () => {
			const list = document.querySelector("#omie-list");
			list.innerHTML = PP.skeleton(4);
			const params = new URLSearchParams({ from: form.from.value, to: form.to.value });
			if (state.page) params.set("page", state.page);
			if (state.kind === "invoices") params.set("type", form.type.value);
			try {
				render(await api.get(`/api/omie/${state.kind}?${params}`));
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
		await load();
	}

	const pages = {
		omie: omiePage,
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
		window.PPShellTools?.mount();
		loading();
		await pages[pageType]();
	} catch (error) {
		failure(error, () => window.location.reload());
	}
})();
