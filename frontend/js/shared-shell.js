(() => {
  if (window.__sharedShellInitialized) return;
  window.__sharedShellInitialized = true;
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;
  const pageCache = new Map();
  const labels = {
    "/": "Dashboard",
    "/triagem.html": "Triagem",
    "/pedido-venda.html": "Pedido de venda",
    "/base-troca.html": "Base de troca",
    "/garantia.html": "Garantia",
    "/historico.html": "Histórico",
    "/relatorios.html": "Relatórios",
    "/relatorios-time.html": "Desempenho por time",
    "/relatorios-gerentes.html": "Desempenho de gerentes",
    "/cadastros.html": "Usuários",
    "/cadastro-base.html": "Clientes e produtos",
    "/importar.html": "Importar pedidos",
    "/auditoria.html": "Auditoria",
    "/integracoes.html": "Integrações",
    "/notificacoes.html": "Notificações",
    "/caso.html": "Processo",
    "/configuracoes.html": "Configurações",
    "/conta.html": "Minha conta"
  };

  function trackActivity(action, label) {
    try {
      const session = JSON.parse(localStorage.getItem("plano-pneumatic-session"));
      if (!session?.token) return;
      const apiOrigin = window.location.hostname === "planopneumatic-production.up.railway.app" ? "https://planopneumaticapi-production.up.railway.app" : window.location.origin;
      fetch(new URL("/api/activity", apiOrigin), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ action, path: window.location.pathname, label: String(label || "").slice(0, 200) }),
        keepalive: true
      }).catch(() => {});
    } catch { /* activity tracking must never break navigation */ }
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("a, button");
    if (!target) return;
    trackActivity("click", target.textContent.trim() || target.getAttribute("aria-label") || target.tagName.toLowerCase());
  }, true);

  function setLoading(active) {
    let loading = document.querySelector("#shell-loading");
    if (!loading) {
      loading = document.createElement("div");
      loading.id = "shell-loading";
      loading.className = "shell-loading hidden";
      loading.innerHTML = '<span class="loading-spinner" aria-hidden="true"></span><span>Carregando tela...</span>';
      document.body.appendChild(loading);
    }
    loading.classList.toggle("hidden", !active);
  }

  function showNavigationError(message) {
    const content = document.querySelector(".dashboard-content");
    if (!content) return;
    content.innerHTML = `<section class="page-error" role="alert"><p class="eyebrow">Indisponibilidade temporária</p><h1>Não foi possível carregar esta tela.</h1><p>${message}</p><button class="button button-primary" type="button" data-retry-navigation>Tentar novamente</button></section>`;
    content.querySelector("[data-retry-navigation]").addEventListener("click", () => navigate(window.location.href, false));
  }

  function renderBreadcrumb(path) {
    const topbar = document.querySelector(".dashboard-content .topbar");
    if (!topbar || path === "/") return;
    let breadcrumb = topbar.querySelector(".breadcrumb");
    if (!breadcrumb) {
      breadcrumb = document.createElement("p");
      breadcrumb.className = "breadcrumb";
      topbar.prepend(breadcrumb);
    }
    breadcrumb.innerHTML = `<a href="/">Dashboard</a><span aria-hidden="true">/</span><strong>${labels[path] || "Operação"}</strong>`;
  }

  function savePageState() {
    const form = document.querySelector("#search-form");
    if (form) sessionStorage.setItem("history-filters", JSON.stringify(Object.fromEntries(new FormData(form))));
    sessionStorage.setItem(`scroll:${window.location.pathname}`, String(window.scrollY));
  }

  function restorePageState(path) {
    const savedFilters = sessionStorage.getItem("history-filters");
    const form = document.querySelector("#search-form");
    if (form && savedFilters) {
      const values = JSON.parse(savedFilters);
      Object.entries(values).forEach(([name, value]) => { if (form.elements[name]) form.elements[name].value = value; });
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
    window.scrollTo(0, Number(sessionStorage.getItem(`scroll:${path}`) || 0));
  }

  function syncStylesheets(nextDocument) {
    const nextHrefs = new Set([...nextDocument.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.getAttribute("href")));
    document.querySelectorAll('head link[rel="stylesheet"]').forEach((link) => {
      const href = link.getAttribute("href");
      if (href && !nextHrefs.has(href)) link.remove();
    });
    const currentHrefs = new Set([...document.querySelectorAll('head link[rel="stylesheet"]')].map((link) => link.getAttribute("href")));
    nextHrefs.forEach((href) => {
      if (!href || currentHrefs.has(href)) return;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    });
  }

  async function navigate(href, pushState = true) {
    const currentPath = window.location.pathname === "/" ? "/" : window.location.pathname.replace(/\/$/, "");
    const targetPath = new URL(href, window.location.origin).pathname.replace(/\/$/, "") || "/";
    if (targetPath === currentPath) return;
    if (targetPath === "/") {
      window.location.href = href;
      return;
    }
    savePageState();
    setLoading(true);
    try {
      let nextDocument = pageCache.get(targetPath);
      if (!nextDocument) {
        const response = await fetch(href, { headers: { "X-Layout-Navigation": "partial" } });
        if (!response.ok) throw new Error("A página não respondeu corretamente.");
        nextDocument = new DOMParser().parseFromString(await response.text(), "text/html");
        pageCache.set(targetPath, nextDocument);
      }
      const nextContent = nextDocument.querySelector(".dashboard-content");
      const currentContent = document.querySelector(".dashboard-content");
      if (!nextContent || !currentContent) throw new Error("A estrutura da página é inválida.");
      const nextLayout = nextDocument.querySelector(".dashboard-layout");
      const currentLayout = document.querySelector(".dashboard-layout");
      if (nextLayout && currentLayout) {
        [...currentLayout.attributes].forEach((attr) => { if (!nextLayout.hasAttribute(attr.name)) currentLayout.removeAttribute(attr.name); });
        [...nextLayout.attributes].forEach((attr) => currentLayout.setAttribute(attr.name, attr.value));
      }
      syncStylesheets(nextDocument);
      currentContent.replaceWith(nextContent.cloneNode(true));
      document.title = nextDocument.title;
      if (pushState) window.history.pushState({}, "", href);
      trackActivity("navigation", labels[targetPath] || targetPath);
      renderNavigation();
      renderBreadcrumb(targetPath);
      window.PPShellTools?.mount();
      const scripts = [...nextDocument.querySelectorAll("script[src]")];
      for (const script of scripts) {
        const loadedScript = document.createElement("script");
        loadedScript.src = `${script.src}?navigation=${Date.now()}`;
        loadedScript.type = "module";
        await new Promise((resolve) => { loadedScript.onload = resolve; loadedScript.onerror = resolve; document.body.appendChild(loadedScript); });
      }
      restorePageState(targetPath);
    } catch (error) {
      showNavigationError(error.message);
    } finally {
      setLoading(false);
    }
  }

  function renderNavigation() {
    const currentPath = window.location.pathname === "/" ? "/" : window.location.pathname.replace(/\/$/, "");
    const nav = sidebar.querySelector(".nav");
    if (!nav) return;
    nav.querySelectorAll("a[href]").forEach((link) => {
      const linkPath = new URL(link.href, window.location.origin).pathname.replace(/\/$/, "") || "/";
      link.classList.toggle("active", linkPath === currentPath);
    });
  }

  // [href, icone, rotulo, chave, capacidade exigida (opcional)]
  const navigation = [
    ["/", "▦", "Dashboard", "dashboard"],
    ["/triagem.html", "◎", "Triagem", "triagem", "cases.create"],
    ["/pedido-venda.html", "▤", "Pedidos de venda", "pedido", "cases.create"],
    ["/base-troca.html", "↻", "Base de troca", "troca", "cases.create"],
    ["/garantia.html", "✓", "Garantias", "garantia", "cases.create"],
    ["/historico.html", "◷", "Histórico", "historico"],
    ["/relatorios.html", "▥", "Relatórios", "relatorios"],
    ["/cadastro-base.html", "▣", "Clientes e produtos", "registro", "cases.create"],
    ["/importar.html", "⇪", "Importar pedidos", "importar", "cases.import"],
    ["/cadastros.html", "♙", "Usuários", "cadastros", "users.view"],
    ["/auditoria.html", "☰", "Auditoria", "auditoria", "users.audit.view"],
    ["/integracoes.html", "⇄", "Integrações", "integracoes", "integrations.manage"],
    ["/configuracoes.html", "⚙", "Configurações", "configuracoes"],
    ["/conta.html", "◉", "Minha conta", "conta"]
  ];
  const readSession = () => {
    try { return JSON.parse(localStorage.getItem("plano-pneumatic-session")); } catch { return null; }
  };
  // Sessoes antigas nao guardam capacidades: ate atualizar, mostra apenas o que nao depende delas.
  const allowed = (capability) => !capability || (readSession()?.user?.capabilities || []).includes(capability);

  const nav = sidebar.querySelector(".nav");
  function renderNavLinks() {
    if (!nav) return;
    const path = window.location.pathname === "/" ? "/" : window.location.pathname.replace(/\/$/, "");
    nav.innerHTML = navigation.filter(([, , , , capability]) => allowed(capability)).map(([href, icon, label, key]) => {
      const active = href === path || (path === "/caso.html" && key === "historico");
      return `<a class="nav-link${active ? " active" : ""}" href="${href}" data-nav-key="${key}"${active ? ' aria-current="page"' : ""}><span aria-hidden="true">${icon}</span> ${label}</a>`;
    }).join("");
  }

  const currentPath = window.location.pathname === "/" ? "/" : window.location.pathname.replace(/\/$/, "");
  const toolsScript = document.createElement("script");
  toolsScript.src = "/js/shell-tools.js";
  document.head.appendChild(toolsScript);
  // Atualiza as capacidades do usuario (o perfil pode ter mudado) e redesenha o menu.
  function refreshUser() {
    if (!readSession()?.token || !window.PP) return;
    window.PP.api.get("/api/auth/me").then((data) => {
      window.PP.setSession({ ...readSession(), user: data.user });
      renderNavLinks();
      window.PPShellTools?.mount();
    }).catch(() => {});
  }
  if (document.readyState === "complete") refreshUser(); else window.addEventListener("load", refreshUser);
  // Disparado pela tela de login quando a sessao muda (o menu depende das capacidades do usuario).
  window.addEventListener("pp-session-changed", () => { renderNavLinks(); window.PPShellTools?.mount(); });

  if (nav) {
    nav.setAttribute("aria-label", "Navegação principal");
    renderNavLinks();
    nav.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      if (!link || new URL(link.href, window.location.origin).origin !== window.location.origin) return;
      event.preventDefault();
      navigate(link.href).catch(() => { window.location.href = link.href; });
    });
  }

  const brand = sidebar.querySelector(".brand-sidebar");
  if (brand) brand.innerHTML = '<img src="/logo.png" alt="Plano Pneumatic" /><span>OPERAÇÃO</span>';
  renderBreadcrumb(currentPath);
  trackActivity("navigation", labels[currentPath] || currentPath);
  window.addEventListener("popstate", () => navigate(window.location.href, false));
})();
