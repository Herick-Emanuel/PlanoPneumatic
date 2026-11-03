const sharedShellScript = document.createElement("script");
sharedShellScript.src = "/js/shared-shell.js";
document.head.appendChild(sharedShellScript);

const PP = window.PP;
const { esc, api: apiRequest } = PP;
const loginView = document.querySelector("#login-view");
const dashboardView = document.querySelector("#dashboard-view");
const loginForm = document.querySelector("#login-form");
const feedback = document.querySelector("#login-feedback");
let refreshTimer = null;

function showLogin(message = "") {
  try { message = message || sessionStorage.getItem(PP.SESSION_EXPIRED_KEY) || ""; sessionStorage.removeItem(PP.SESSION_EXPIRED_KEY); } catch { /* sem sessionStorage */ }
  clearInterval(refreshTimer);
  loginView.classList.remove("hidden");
  dashboardView.classList.add("hidden");
  feedback.textContent = message;
}

function showApiUnavailable() {
  loginView.classList.remove("hidden");
  dashboardView.classList.add("hidden");
  loginView.innerHTML = '<section class="page-error" role="alert"><p class="eyebrow">Serviço indisponível</p><h1>Não foi possível conectar ao sistema.</h1><p>Verifique sua conexão e tente novamente em instantes.</p><button class="button button-primary" type="button" id="retry-api">Tentar novamente</button></section>';
  document.querySelector("#retry-api").addEventListener("click", () => window.location.reload());
}

function showDashboard(user) {
  loginView.classList.add("hidden");
  dashboardView.classList.remove("hidden");
  document.querySelector("#welcome-name").textContent = user.name.split(" ")[0];
  PP.fillProfile(user);
  const dateLabel = document.querySelector(".date-label");
  if (dateLabel) dateLabel.textContent = new Date().toLocaleDateString("pt-BR", { dateStyle: "long", timeZone: "America/Sao_Paulo" });
}

function renderDashboard(data) {
  document.querySelector("#indicator-grid").innerHTML = data.indicators.map((indicator) => `
    <article class="indicator-card ${esc(indicator.tone)}">
      <div class="indicator-top"><span>${esc(indicator.label)}</span><span class="indicator-mark" aria-hidden="true">${indicator.tone === "red" ? "!" : "↗"}</span></div>
      <strong>${esc(indicator.value)}</strong>
      <small>Atualizado agora</small>
    </article>
  `).join("");

  document.querySelector("#cases-body").innerHTML = data.recentCases.map((item) => `
    <tr class="case-row"><td><a class="table-link" href="/caso.html?id=${encodeURIComponent(item.id)}">${esc(item.id)}</a></td><td>${esc(item.client)}</td><td>${esc(item.type)}</td><td><span class="table-status ${PP.statusTone(item.status)}">${esc(PP.statusLabel(item.status))}</span></td><td>${PP.slaBadge(item)}</td><td class="muted">${esc(item.updatedAt)}</td></tr>
  `).join("") || `<tr><td colspan="6">${PP.emptyState("Nenhum processo no período", "Crie um processo na triagem para começar.", '<a class="button button-primary compact-button" href="/triagem.html">+ Novo processo</a>')}</td></tr>`;
  renderInsights(data);
}

function renderInsights(data) {
  document.querySelector("#comparison-grid").innerHTML = `<div><span>Abertos</span><strong>${esc(data.comparison.openCases)}</strong></div><div><span>Concluídos</span><strong>${esc(data.comparison.completed)}</strong></div>`;
  const maxType = Math.max(...data.byType.map((item) => item.value), 1);
  document.querySelector("#type-chart").innerHTML = data.byType.map((item) => `<div class="distribution-row"><div><strong>${esc(item.label)}</strong><span>${esc(item.value)}</span></div><i style="width:${Math.max(8, item.value / maxType * 100)}%"></i></div>`).join("") || '<p class="muted">Sem dados no período.</p>';
  const maxEvolution = Math.max(...data.evolution.map((item) => item.total), 1);
  document.querySelector("#evolution-chart").innerHTML = data.evolution.map((item) => `<div class="chart-column" title="${esc(item.date)}: ${esc(item.total)} processos"><span style="height:${Math.max(8, item.total / maxEvolution * 100)}%"></span><small>${esc(String(item.date).slice(5))}</small></div>`).join("") || '<p class="muted">Sem dados no período.</p>';
  const alertList = document.querySelector("#alert-list");
  document.querySelector("#alert-count").textContent = `${data.alerts.length} alerta${data.alerts.length === 1 ? "" : "s"}`;
  alertList.innerHTML = data.alerts.map((item) => `<a class="alert-row" href="/caso.html?id=${encodeURIComponent(item.id)}"><strong>${esc(item.id)}</strong><span>${esc(item.client)}</span><small>${item.overdue ? "Prazo vencido em" : "Vence em"} ${esc(PP.formatDateTime(item.dueAt))} · ${esc(PP.statusLabel(item.status))}</small></a>`).join("") || '<p class="muted">Nenhum processo vencido ou próximo do vencimento.</p>';
}

function dashboardQuery() {
  const form = document.querySelector("#dashboard-filters");
  const params = new URLSearchParams(new FormData(form));
  [...params.keys()].forEach((key) => { if (!params.get(key)) params.delete(key); });
  sessionStorage.setItem("dashboard-filters", JSON.stringify(Object.fromEntries(params)));
  return params.toString() ? `?${params}` : "";
}

function renderAttention(items) {
  const actionList = document.querySelector("#action-list");
  if (!actionList) return;
  actionList.innerHTML = items.slice(0, 5).map((item) => `<li class="action-item"><a href="/caso.html?id=${encodeURIComponent(item.id)}" style="display:contents;color:inherit;text-decoration:none"><span class="action-icon ${item.risk === "Alto" ? "red" : "orange"}" aria-hidden="true">${item.risk === "Alto" ? "!" : "◷"}</span><div><strong>${esc(item.id)} · ${esc(item.description)}</strong><small>${esc(item.client)} · ${esc(item.responsible)}</small></div><span aria-hidden="true">→</span></a></li>`).join("") || `<li class="empty-action">Nenhuma próxima ação no seu escopo.</li>`;
}

// F15: dashboard avancado (comparativo mensal, tempo por etapa, reincidencia, custo de garantia, metas).
async function renderAdvanced() {
  const content = document.querySelector("#dashboard-view .dashboard-content");
  let panel = document.querySelector("#advanced-panel");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "advanced-panel";
    panel.className = "panel";
    content.appendChild(panel);
  }
  try {
    const data = await apiRequest(`/api/reports/advanced${dashboardQuery()}`);
    const maxMonth = Math.max(...data.monthly.map((item) => item.total), 1);
    panel.innerHTML = `
      <div class="panel-heading"><div><p class="eyebrow">Análise avançada</p><h2>Evolução mensal e qualidade</h2></div></div>
      <div class="content-grid">
        <article><p class="eyebrow">Comparativo mensal</p><div class="bar-chart" role="img" aria-label="Processos por mês">${data.monthly.map((item) => `<div class="chart-column" title="${esc(item.month)}: ${esc(item.total)} abertos, ${esc(item.completed)} concluídos"><span style="height:${Math.max(8, item.total / maxMonth * 100)}%"></span><small>${esc(item.month.slice(2))}</small></div>`).join("") || '<p class="muted">Sem dados.</p>'}</div></article>
        <article><p class="eyebrow">Tempo médio por etapa (dias)</p>${data.stageDurations.map((item) => `<div class="distribution-row"><div><strong>${esc(PP.statusLabel(item.stage))}</strong><span>${esc(item.average_days)}</span></div></div>`).join("") || '<p class="muted">Ainda sem histórico suficiente.</p>'}</article>
      </div>
      <div class="content-grid" style="margin-top:16px">
        <article><p class="eyebrow">Reincidência de defeito (produtos com 2+ ocorrências)</p>${data.recurrence.map((item) => `<div class="distribution-row"><div><strong>${esc(item.productCode)} · ${esc(item.product)}</strong><span>${esc(item.total)}</span></div></div>`).join("") || '<p class="muted">Nenhuma reincidência.</p>'}</article>
        <article><p class="eyebrow">Custo estimado de garantia</p><strong style="font-size:24px">${esc(PP.money(data.warrantyCost.estimated))}</strong><p class="muted">${esc(data.warrantyCost.approved)} garantia(s) procedente(s) com valor unitário informado.</p><p class="eyebrow">Metas do mês</p>${data.goals.map((goal) => `<div class="distribution-row"><div><strong>${esc(goal.managerName)}</strong><span>${esc(goal.achieved)}/${esc(goal.monthlyTarget)}</span></div><i style="width:${Math.min(100, goal.achieved / goal.monthlyTarget * 100)}%"></i></div>`).join("") || '<p class="muted">Sem metas definidas (Desempenho por time).</p>'}</article>
      </div>`;
  } catch (error) { panel.innerHTML = `<p class="feedback">${esc(error.message)}</p>`; }
}

async function loadSummary(user) {
  const data = await apiRequest(`/api/dashboard/summary${dashboardQuery()}`);
  renderDashboard(data);
  const pendingData = await apiRequest("/api/pending");
  renderAttention(pendingData.items);
  if (user && !PP.getSession()?.user?.capabilities?.includes("cases.view.all")) document.querySelector("#advanced-panel")?.remove(); else renderAdvanced();
}

async function populateFilters() {
  const meta = await PP.meta();
  const form = document.querySelector("#dashboard-filters");
  const status = form.elements.status;
  if (status && !status.dataset.ready) {
    status.dataset.ready = "1";
    status.innerHTML = `<option value="">Todos</option>${meta.statuses.map((entry) => `<option value="${esc(entry.code)}">${esc(entry.label)}</option>`).join("")}`;
  }
}

async function loadDashboard(user) {
  showDashboard(user);
  document.querySelector("#cases-body").innerHTML = `<tr><td colspan="6">${PP.skeleton(4)}</td></tr>`;
  try {
    await populateFilters();
    const filterForm = document.querySelector("#dashboard-filters");
    const savedFilters = sessionStorage.getItem("dashboard-filters");
    if (savedFilters) Object.entries(JSON.parse(savedFilters)).forEach(([name, value]) => { if (filterForm.elements[name]) filterForm.elements[name].value = value; });
    if (!filterForm.dataset.bound) {
      filterForm.dataset.bound = "true";
      filterForm.addEventListener("submit", async (event) => { event.preventDefault(); await loadDashboard(user); });
      document.querySelector("#clear-dashboard-filters").addEventListener("click", () => { filterForm.reset(); sessionStorage.removeItem("dashboard-filters"); loadDashboard(user); });
    }
    await loadSummary(user);
    window.PPShellTools?.mount();
    // Configuracao "atualizacao automatica": atualiza indicadores a cada minuto enquanto a aba esta visivel.
    clearInterval(refreshTimer);
    const settings = await apiRequest("/api/settings").catch(() => null);
    if (settings?.settings.auto_refresh) refreshTimer = setInterval(() => { if (!document.hidden) loadSummary(user).catch(() => {}); }, 60000);
    const created = new URLSearchParams(window.location.search).get("created");
    if (created) { PP.toast(`Processo ${created} criado.`, "success"); window.history.replaceState({}, "", "/"); }
  } catch (error) {
    if (error.status === 0) showApiUnavailable();
    else document.querySelector("#cases-body").innerHTML = `<tr><td colspan="6">${PP.errorState(error.message)}</td></tr>`;
    document.querySelector("#cases-body [data-retry]")?.addEventListener("click", () => loadDashboard(user));
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  feedback.textContent = "";
  const submitButton = loginForm.querySelector("button");
  submitButton.disabled = true;

  try {
    const data = await apiRequest("/api/auth/login", { method: "POST", json: { email: loginForm.email.value, password: loginForm.password.value } });
    PP.setSession(data);
    const me = await apiRequest("/api/auth/me");
    PP.setSession({ ...data, user: me.user });
    window.dispatchEvent(new Event("pp-session-changed"));
    await loadDashboard(me.user);
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

PP.bindLogout();

const pwaInstallBlock = document.querySelector("#pwa-install-block");
const pwaInstallButton = document.querySelector("#pwa-install-button");
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
function refreshInstallBlock() {
  if (isStandalone) return pwaInstallBlock?.classList.add("hidden");
  pwaInstallBlock?.classList.toggle("hidden", !window.__pwaInstallPrompt);
}
refreshInstallBlock();
window.addEventListener("pwa-install-available", refreshInstallBlock);
window.addEventListener("pwa-installed", refreshInstallBlock);
pwaInstallButton?.addEventListener("click", async () => {
  const promptEvent = window.__pwaInstallPrompt;
  if (!promptEvent) return;
  pwaInstallButton.disabled = true;
  promptEvent.prompt();
  await promptEvent.userChoice;
  window.__pwaInstallPrompt = null;
  pwaInstallButton.disabled = false;
  refreshInstallBlock();
});

(async function bootstrap() {
  const session = PP.getSession();
  if (!session?.token) return showLogin();
  try {
    const data = await apiRequest("/api/auth/me");
    PP.setSession({ ...session, user: data.user });
    await loadDashboard(data.user);
  } catch (error) {
    if (error.status === 0) showApiUnavailable(); else showLogin();
  }
})();
