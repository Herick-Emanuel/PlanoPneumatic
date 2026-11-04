// Modulo comum (PDF 4: "api.js e session.js"): sessao, fetch, escape, formatadores e metadados.
(() => {
	if (window.PP) return;
	const sessionKey = "plano-pneumatic-session";
	const apiOrigin = window.location.hostname === "planopneumatic-production.up.railway.app" ? "https://planopneumaticapi-production.up.railway.app" : window.location.origin;
	const SESSION_EXPIRED_KEY = "pp-session-expired";

	const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
	const getSession = () => { try { return JSON.parse(localStorage.getItem(sessionKey)); } catch { return null; } };
	const setSession = (session) => localStorage.setItem(sessionKey, JSON.stringify(session));
	const clearSession = () => localStorage.removeItem(sessionKey);
	const apiUrl = (url) => new URL(url, apiOrigin).toString();

	class ApiError extends Error {
		constructor(message, status, body) { super(message); this.status = status; this.body = body; }
	}

	function sessionExpired(message = "Sua sessão expirou. Entre novamente.") {
		clearSession();
		try { sessionStorage.setItem(SESSION_EXPIRED_KEY, message); } catch { /* sem sessionStorage */ }
		if (window.location.pathname !== "/") window.location.href = "/";
	}

	async function request(url, options = {}) {
		const session = getSession();
		const { json, raw, ...fetchOptions } = options;
		const headers = { ...(fetchOptions.headers || {}) };
		if (session?.token) headers.Authorization = `Bearer ${session.token}`;
		if (json !== undefined) { headers["Content-Type"] = "application/json"; fetchOptions.body = JSON.stringify(json); }
		let response;
		try { response = await fetch(apiUrl(url), { ...fetchOptions, headers }); } catch { throw new ApiError("Sem conexão com o servidor. Verifique a internet e tente novamente.", 0); }
		if (response.status === 401 && session?.token && !url.includes("/api/auth/login")) { sessionExpired(); throw new ApiError("Sua sessão expirou. Entre novamente.", 401); }
		if (raw) return response;
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			throw new ApiError(body.message || "Não foi possível concluir a operação.", response.status, body);
		}
		return response.status === 204 ? null : response.json();
	}

	const api = (url, options) => request(url, options);
	api.get = (url) => request(url);
	api.post = (url, json) => request(url, { method: "POST", json });
	api.patch = (url, json) => request(url, { method: "PATCH", json });
	api.put = (url, json) => request(url, { method: "PUT", json });
	api.delete = (url) => request(url, { method: "DELETE" });

	// Exige sessao: sem token volta ao login. Atualiza capacidades do usuario (perfil pode ter mudado).
	async function requireUser() {
		const session = getSession();
		if (!session?.token) { window.location.href = "/"; return null; }
		const data = await api.get("/api/auth/me");
		setSession({ ...session, user: data.user });
		return data.user;
	}

	let metaPromise;
	const meta = () => (metaPromise ||= api.get("/api/meta").catch((error) => { metaPromise = null; throw error; }));
	let metaCache = null;
	meta().then((value) => { metaCache = value; }).catch(() => {});

	const FALLBACK_LABELS = { Concluido: "Concluído", "Em analise": "Em análise" };
	const statusLabel = (code) => metaCache?.statuses.find((status) => status.code === code)?.label || FALLBACK_LABELS[code] || code;
	const statusTone = (code) => {
		if (["Aprovado", "Concluido", "Encerrado"].includes(code)) return "green";
		if (["Aguardando documento", "Em analise", "Em faturamento", "Processando"].includes(code)) return "orange";
		if (["Improcedente", "Cancelado"].includes(code)) return "red";
		return "blue";
	};
	const roleLabel = (role) => ({ admin: "Administrador", manager: "Gerente", supervisor: "Supervisor", operator: "Operador", technician: "Técnico", logistics: "Logística", auditor: "Auditor" }[role] || role);
	const can = (capability) => Boolean(getSession()?.user?.capabilities?.includes(capability));

	const SLA_TEXT = { ok: ["No prazo", "green"], warning: ["Vence em breve", "orange"], overdue: ["Atrasado", "red"], paused: ["Prazo pausado", "blue"], done: ["Finalizado", "blue"] };
	const slaBadge = (item) => {
		const [text, tone] = SLA_TEXT[item.sla] || SLA_TEXT.ok;
		return `<span class="table-status ${tone}">${text}${item.dueAt && !["done", "paused"].includes(item.sla) ? ` · ${esc(formatDate(item.dueAt))}` : ""}</span>`;
	};

	const formatDate = (value) => (value ? new Date(value).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }) : "");
	const formatDateTime = (value) => (value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "");
	const money = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
	const fileSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
	const initials = (name) => String(name || "").split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();

	// --- CPF/CNPJ -----------------------------------------------------------------
	const digits = (value) => String(value || "").replace(/\D/g, "");
	function isValidCpf(value) {
		if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
		for (const length of [9, 10]) {
			let sum = 0;
			for (let index = 0; index < length; index += 1) sum += Number(value[index]) * (length + 1 - index);
			if (((sum * 10) % 11) % 10 !== Number(value[length])) return false;
		}
		return true;
	}
	function isValidCnpj(value) {
		if (!/^\d{14}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
		for (const length of [12, 13]) {
			const weights = length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
			let sum = 0;
			for (let index = 0; index < length; index += 1) sum += Number(value[index]) * weights[index];
			const rest = sum % 11;
			if ((rest < 2 ? 0 : 11 - rest) !== Number(value[length])) return false;
		}
		return true;
	}
	const isValidDocument = (value) => { const numbers = digits(value); return isValidCpf(numbers) || isValidCnpj(numbers); };
	function formatDocument(value) {
		const numbers = digits(value).slice(0, 14);
		if (numbers.length <= 11) return numbers.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
		return numbers.replace(/^(\d{2})(\d)/, "$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d)/, ".$1/$2").replace(/(\d{4})(\d)/, "$1-$2");
	}

	// Mascara + validacao de documento em um input; mostra o erro ao lado do campo.
	function bindDocumentInput(input) {
		input.setAttribute("inputmode", "numeric");
		input.addEventListener("input", () => { input.value = formatDocument(input.value); setFieldError(input, ""); });
		input.addEventListener("blur", () => setFieldError(input, input.value && !isValidDocument(input.value) ? "CPF ou CNPJ inválido." : ""));
	}
	function bindMoneyInput(input) {
		input.addEventListener("blur", () => {
			const parsed = parseMoney(input.value);
			input.value = Number.isFinite(parsed) ? parsed.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
		});
	}
	const parseMoney = (value) => { const text = String(value || "").trim(); if (!text) return NaN; return Number(text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text); };

	// --- Mensagens de erro ao lado do campo -----------------------------------------
	function setFieldError(input, message) {
		const label = input.closest("label") || input.parentElement;
		let hint = label.querySelector(":scope > .field-error");
		if (!message) { hint?.remove(); input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby"); return; }
		if (!hint) { hint = document.createElement("small"); hint.className = "field-error"; hint.id = `err-${Math.random().toString(36).slice(2, 8)}`; label.appendChild(hint); }
		hint.textContent = message;
		input.setAttribute("aria-invalid", "true");
		input.setAttribute("aria-describedby", hint.id);
	}
	function clearFieldErrors(form) { form.querySelectorAll(".field-error").forEach((hint) => hint.remove()); form.querySelectorAll("[aria-invalid]").forEach((input) => input.removeAttribute("aria-invalid")); }
	// Aplica os erros de validacao devolvidos pela API (errors: [{ field, message }]) aos campos.
	function applyServerErrors(form, error) {
		let applied = 0;
		for (const issue of error.body?.errors || []) {
			const input = form.elements[issue.field.split(".")[0]];
			if (input && input.nodeType === 1) { setFieldError(input, issue.message); applied += 1; }
		}
		if (applied) form.querySelector("[aria-invalid]")?.focus();
		return applied;
	}

	// --- Toast e dialogo de confirmacao --------------------------------------------
	function toast(message, tone = "info", actionLabel, onAction) {
		let host = document.querySelector("#toast-host");
		if (!host) { host = document.createElement("div"); host.id = "toast-host"; host.setAttribute("role", "status"); host.setAttribute("aria-live", "polite"); document.body.appendChild(host); }
		const item = document.createElement("div");
		item.className = `toast ${tone}`;
		item.innerHTML = `<span>${esc(message)}</span>${actionLabel ? `<button type="button" class="toast-action">${esc(actionLabel)}</button>` : ""}`;
		host.appendChild(item);
		const remove = () => item.remove();
		item.querySelector(".toast-action")?.addEventListener("click", () => { onAction?.(); remove(); });
		setTimeout(remove, actionLabel ? 8000 : 4500);
	}

	// Modal acessivel (foco preso, Esc fecha). Retorna uma promessa com o resultado de `onSubmit` ou null.
	function dialog({ title, body, confirmLabel = "Confirmar", cancelLabel = "Cancelar", danger = false }) {
		return new Promise((resolve) => {
			const previous = document.activeElement;
			const modal = document.createElement("div");
			modal.className = "modal";
			modal.setAttribute("role", "dialog");
			modal.setAttribute("aria-modal", "true");
			modal.innerHTML = `<form class="modal-card dialog-card form" novalidate><div class="panel-heading"><div><h2>${esc(title)}</h2></div><button class="close-button" type="button" aria-label="Fechar" data-cancel>&times;</button></div><div class="dialog-body">${body}</div><p class="feedback" role="alert"></p><div class="form-actions"><button class="button button-secondary" type="button" data-cancel>${esc(cancelLabel)}</button><button class="button ${danger ? "button-danger" : "button-primary"}" type="submit">${esc(confirmLabel)}</button></div></form>`;
			document.body.appendChild(modal);
			const form = modal.querySelector("form");
			const close = (value) => { modal.remove(); document.removeEventListener("keydown", onKey); previous?.focus?.(); resolve(value); };
			const onKey = (event) => {
				if (event.key === "Escape") close(null);
				if (event.key === "Tab") {
					const focusable = [...form.querySelectorAll("button, input, select, textarea, [href]")].filter((element) => !element.disabled);
					if (!focusable.length) return;
					const first = focusable[0]; const last = focusable[focusable.length - 1];
					if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
					else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
				}
			};
			document.addEventListener("keydown", onKey);
			modal.querySelectorAll("[data-cancel]").forEach((button) => button.addEventListener("click", () => close(null)));
			modal.addEventListener("mousedown", (event) => { if (event.target === modal) close(null); });
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				if (!form.reportValidity()) return;
				close(Object.fromEntries(new FormData(form)));
			});
			(form.querySelector("input, select, textarea") || form.querySelector("button[type=submit]")).focus();
		});
	}
	const confirmAction = (title, message, confirmLabel, danger) => dialog({ title, body: `<p>${esc(message)}</p>`, confirmLabel, danger }).then(Boolean);

	// --- Perfil / logout ------------------------------------------------------------
	function fillProfile(user) {
		const set = (selector, value) => { const element = document.querySelector(selector); if (element) element.textContent = value; };
		set("#profile-name", user.name);
		set("#profile-role", roleLabel(user.role));
		set("#profile-initials", initials(user.name));
	}
	async function logout() {
		try { await api.post("/api/auth/logout"); } catch { /* sessao ja encerrada */ }
		clearSession();
		window.location.href = "/";
	}
	function bindLogout() {
		document.querySelectorAll("#logout-button, [data-logout]").forEach((button) => { if (button.dataset.boundLogout) return; button.dataset.boundLogout = "1"; button.addEventListener("click", logout); });
	}

	// Download autenticado (o token nao vai na URL): baixa como blob e abre/salva.
	async function fetchBlob(url) {
		const response = await request(url, { raw: true });
		if (!response.ok) throw new ApiError((await response.json().catch(() => ({}))).message || "Não foi possível baixar o arquivo.", response.status);
		return { blob: await response.blob(), response };
	}
	async function download(url, fileName) {
		const { blob } = await fetchBlob(url);
		const link = document.createElement("a");
		link.href = URL.createObjectURL(blob);
		link.download = fileName;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(link.href), 10000);
	}
	async function openFile(url) {
		const { blob } = await fetchBlob(url);
		window.open(URL.createObjectURL(blob), "_blank", "noopener");
	}

	// Fila offline: processos preenchidos sem conexao sao reenviados quando a internet volta.
	const OUTBOX_KEY = "pp-outbox";
	const outbox = {
		list() { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; } catch { return []; } },
		save(list) { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); } catch { /* sem armazenamento */ } },
		add(payload) { this.save([...this.list(), { payload, queuedAt: new Date().toISOString() }]); },
		async flush() {
			if (!getSession()?.token || outbox.flushing) return;
			outbox.flushing = true;
			try {
				let pending = outbox.list();
				while (pending.length) {
					try {
						const result = await api.post("/api/cases", pending[0].payload);
						toast(`Processo ${result.case.id} enviado (estava na fila offline).`, "success");
					} catch (error) {
						if (error.status === 0 || error.status === 401) break;
						toast(`Um processo da fila offline foi recusado: ${error.message}`, "error");
					}
					pending = pending.slice(1);
					outbox.save(pending);
				}
			} finally { outbox.flushing = false; }
		}
	};
	window.addEventListener("online", () => outbox.flush());
	window.addEventListener("load", () => outbox.flush());

	const debounce = (fn, wait = 250) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; };
	const skeleton = (rows = 4) => `<div class="skeleton-list" aria-busy="true" aria-label="Carregando">${Array.from({ length: rows }, () => '<div class="skeleton-row"></div>').join("")}</div>`;
	const emptyState = (title, hint, action) => `<div class="empty-state"><strong>${esc(title)}</strong>${hint ? `<p class="muted">${esc(hint)}</p>` : ""}${action || ""}</div>`;
	const errorState = (message) => `<div class="empty-state error-state" role="alert"><strong>${esc(message)}</strong><button class="button button-secondary" type="button" data-retry>Tentar novamente</button></div>`;

	// Icones SVG (traço, 24x24) usados no menu e nas ferramentas do topo.
	const ICONS = {
		dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
		triage: '<path d="M3 4h18l-7 8.5V18l-4 2v-7.5z"/>',
		order: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
		exchange: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
		warranty: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
		history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
		reports: '<path d="M3 3v18h18"/><path d="M8 17v-4M13 17V8M18 17v-7"/>',
		registry: '<path d="m21 8-9-5-9 5 9 5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
		import: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
		users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
		audit: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9z"/><path d="M9 11h6M9 15h6M9 19h3"/>',
		integrations: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
		settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
		account: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.6 18.6a6 6 0 0 1 10.8 0"/>',
		bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
		search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
		logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
		menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
		collapse: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m15.5 10-2 2 2 2"/>',
		expand: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m13.5 10 2 2-2 2"/>',
		sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
		moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
		monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		close: '<path d="M18 6 6 18M6 6l12 12"/>'
	};
	const icon = (name, className = "icon") => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ""}</svg>`;

	// Tema: "auto" segue o sistema; "light"/"dark" ficam salvos no navegador.
	const THEME_KEY = "pp-theme";
	const getTheme = () => { try { return localStorage.getItem(THEME_KEY) || "auto"; } catch { return "auto"; } };
	function setTheme(theme) {
		try { if (theme === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, theme); } catch { /* sem armazenamento */ }
		if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
		window.dispatchEvent(new CustomEvent("pp-theme-changed", { detail: theme }));
	}

	window.PP = {
		sessionKey, apiOrigin, esc, getSession, setSession, clearSession, api, ApiError, requireUser, meta, getMeta: () => metaCache,
		statusLabel, statusTone, roleLabel, can, slaBadge, formatDate, formatDateTime, money, fileSize, initials,
		digits, isValidDocument, formatDocument, bindDocumentInput, bindMoneyInput, parseMoney, setFieldError, clearFieldErrors, applyServerErrors,
		icon, getTheme, setTheme, outbox, toast, dialog, confirmAction, fillProfile, logout, bindLogout, download, openFile, debounce, skeleton, emptyState, errorState, SESSION_EXPIRED_KEY
	};
})();
