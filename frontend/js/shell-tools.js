// Busca global (Ctrl+K), sino de notificacoes e atalhos de teclado. Montado no .topbar de cada tela.
(() => {
	if (window.PPShellTools) return;
	let pollTimer;
	let panel;
	let unread = 0;

	const caseUrl = (id) => `/caso.html?id=${encodeURIComponent(id)}`;

	function openPalette() {
		if (document.querySelector(".palette")) return;
		const { esc, api, statusLabel, debounce } = window.PP;
		const previous = document.activeElement;
		const palette = document.createElement("div");
		palette.className = "palette";
		palette.setAttribute("role", "dialog");
		palette.setAttribute("aria-modal", "true");
		palette.setAttribute("aria-label", "Busca global");
		palette.innerHTML = '<div class="palette-card"><input type="search" placeholder="Buscar por processo, cliente, produto, código, série ou lote…" aria-label="Termo de busca" autocomplete="off" /><div class="palette-results" role="listbox" aria-live="polite"><p>Digite para buscar. Use ↑ ↓ e Enter.</p></div></div>';
		document.body.appendChild(palette);
		const input = palette.querySelector("input");
		const results = palette.querySelector(".palette-results");
		let items = [];
		let active = 0;
		const close = () => { palette.remove(); document.removeEventListener("keydown", onKey, true); previous?.focus?.(); };
		const highlight = () => results.querySelectorAll(".palette-result").forEach((element, index) => element.setAttribute("aria-selected", String(index === active)));
		const render = () => {
			results.innerHTML = items.map((item) => `<button type="button" class="palette-result" role="option" data-id="${esc(item.id)}"><span><strong>${esc(item.id)}</strong> · ${esc(item.client)}<br><small class="muted">${esc(item.type)} · ${esc(item.product)}</small></span><span class="table-status ${window.PP.statusTone(item.status)}">${esc(statusLabel(item.status))}</span></button>`).join("") || '<p>Nenhum processo encontrado.</p>';
			active = 0;
			highlight();
		};
		const search = debounce(async () => {
			const term = input.value.trim();
			if (!term) { items = []; results.innerHTML = '<p>Digite para buscar.</p>'; return; }
			try { items = (await api.get(`/api/search?q=${encodeURIComponent(term)}`)).cases; render(); } catch (error) { results.innerHTML = `<p class="feedback">${esc(error.message)}</p>`; }
		}, 200);
		const onKey = (event) => {
			if (event.key === "Escape") { event.stopPropagation(); close(); }
			else if (event.key === "ArrowDown") { event.preventDefault(); active = Math.min(items.length - 1, active + 1); highlight(); }
			else if (event.key === "ArrowUp") { event.preventDefault(); active = Math.max(0, active - 1); highlight(); }
			else if (event.key === "Enter" && items[active]) { event.preventDefault(); window.location.href = caseUrl(items[active].id); }
		};
		document.addEventListener("keydown", onKey, true);
		input.addEventListener("input", search);
		results.addEventListener("click", (event) => { const row = event.target.closest("[data-id]"); if (row) window.location.href = caseUrl(row.dataset.id); });
		palette.addEventListener("mousedown", (event) => { if (event.target === palette) close(); });
		input.focus();
	}

	function setBadge(count) {
		unread = count;
		document.querySelectorAll(".bell-badge").forEach((badge) => { badge.textContent = count > 99 ? "99+" : String(count); badge.classList.toggle("hidden", count === 0); });
	}

	async function refreshNotifications() {
		if (document.hidden || !window.PP?.getSession()?.token) return;
		try { setBadge((await window.PP.api.get("/api/notifications?unread=true")).unread); } catch { /* sem conexao: mantem o contador */ }
	}

	async function togglePanel(button) {
		if (panel) { panel.remove(); panel = null; button.setAttribute("aria-expanded", "false"); return; }
		const { esc, api, formatDateTime } = window.PP;
		panel = document.createElement("div");
		panel.className = "notification-panel";
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "Notificações");
		panel.innerHTML = `<div class="notification-head"><strong>Notificações</strong></div>${window.PP.skeleton(3)}`;
		document.body.appendChild(panel);
		button.setAttribute("aria-expanded", "true");
		try {
			const data = await api.get("/api/notifications");
			setBadge(data.unread);
			panel.innerHTML = `<div class="notification-head"><strong>Notificações</strong><span class="actions"><button type="button" class="chip" data-read-all>Marcar como lidas</button><a class="chip" href="/notificacoes.html">Ver todas</a></span></div>${data.notifications.slice(0, 12).map((item) => `<button type="button" class="notification-item ${item.readAt ? "" : "unread"}" data-id="${esc(item.id)}" data-case="${esc(item.caseNumber || "")}"><span>${esc(item.message)}</span><small>${esc(formatDateTime(item.createdAt))}</small></button>`).join("") || window.PP.emptyState("Tudo em dia", "Nenhuma notificação por aqui.")}`;
			panel.querySelector("[data-read-all]")?.addEventListener("click", async () => { await api.post("/api/notifications/read-all"); setBadge(0); panel.querySelectorAll(".unread").forEach((element) => element.classList.remove("unread")); });
			panel.querySelectorAll(".notification-item").forEach((item) => item.addEventListener("click", async () => {
				await api.patch(`/api/notifications/${item.dataset.id}/read`).catch(() => {});
				if (item.dataset.case) window.location.href = caseUrl(item.dataset.case); else { item.classList.remove("unread"); refreshNotifications(); }
			}));
		} catch (error) { panel.innerHTML = `<div class="notification-head"><strong>Notificações</strong></div>${window.PP.errorState(error.message)}`; }
	}

	// Alterna o tema: automatico (sistema) -> claro -> escuro.
	const THEME_ORDER = ["auto", "light", "dark"];
	const THEME_META = { auto: ["monitor", "Tema automático (segue o sistema)"], light: ["sun", "Tema claro"], dark: ["moon", "Tema escuro"] };
	function syncThemeButton(button) {
		const [iconName, label] = THEME_META[window.PP.getTheme()] || THEME_META.auto;
		button.innerHTML = window.PP.icon(iconName);
		button.setAttribute("aria-label", `${label}. Clique para alternar.`);
		button.title = label;
	}

	function mount() {
		const topbar = document.querySelector(".dashboard-content .topbar");
		if (!topbar || topbar.querySelector(".shell-tools") || !window.PP?.getSession()?.token) return;
		const { icon } = window.PP;
		if (!topbar.querySelector(".menu-button")) {
			const menu = document.createElement("button");
			menu.type = "button";
			menu.className = "menu-button";
			menu.setAttribute("aria-label", "Abrir menu");
			menu.innerHTML = icon("menu");
			menu.addEventListener("click", () => window.PPShell?.openDrawer());
			topbar.prepend(menu);
		}
		const tools = document.createElement("div");
		tools.className = "shell-tools";
		tools.innerHTML = `<button type="button" class="tool-button search-trigger" data-open-search aria-label="Buscar processos (Ctrl+K)">${icon("search")}<span class="label">Buscar processo…</span><kbd>Ctrl K</kbd></button><button type="button" class="tool-button icon-only" data-theme-toggle></button><button type="button" class="tool-button icon-only" data-bell aria-label="Notificações" aria-haspopup="dialog" aria-expanded="false">${icon("bell")}<span class="bell-badge hidden"></span></button>`;
		topbar.appendChild(tools);
		tools.querySelector("[data-open-search]").addEventListener("click", openPalette);
		const themeButton = tools.querySelector("[data-theme-toggle]");
		syncThemeButton(themeButton);
		themeButton.addEventListener("click", () => {
			const next = THEME_ORDER[(THEME_ORDER.indexOf(window.PP.getTheme()) + 1) % THEME_ORDER.length];
			window.PP.setTheme(next);
			syncThemeButton(themeButton);
			window.PP.toast(THEME_META[next][1]);
		});
		const bell = tools.querySelector("[data-bell]");
		bell.addEventListener("click", () => togglePanel(bell));
		setBadge(unread);
		refreshNotifications();
	}

	document.addEventListener("keydown", (event) => {
		const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); if (window.PP?.getSession()?.token) openPalette(); }
		else if (event.key === "/" && !typing && window.PP?.getSession()?.token) { event.preventDefault(); openPalette(); }
		else if (event.key === "Escape" && panel) { panel.remove(); panel = null; }
	});
	document.addEventListener("click", (event) => { if (panel && !panel.contains(event.target) && !event.target.closest("[data-bell]")) { panel.remove(); panel = null; } });
	document.addEventListener("visibilitychange", refreshNotifications);
	pollTimer = setInterval(refreshNotifications, 60000);
	window.addEventListener("pagehide", () => clearInterval(pollTimer));

	window.PPShellTools = { mount, openPalette, refreshNotifications };
	mount();
})();
