// Carregado no <head> (sem defer) para aplicar tema e menu recolhido antes da primeira pintura.
(() => {
	const root = document.documentElement;
	try {
		const theme = localStorage.getItem("pp-theme");
		if (theme === "light" || theme === "dark") root.dataset.theme = theme;
		if (localStorage.getItem("pp-sidebar") === "collapsed") root.classList.add("sidebar-collapsed");
	} catch {
		/* armazenamento indisponivel: segue o tema do sistema */
	}
	// Splash de abertura: na primeira tela de cada abertura do app (aba/janela nova) com o app ja instalado
	// (service worker controlando), mostra a splash enquanto pwa.js procura versao nova e a aplica direto.
	try {
		if ("serviceWorker" in navigator && navigator.serviceWorker.controller && !sessionStorage.getItem("pp-launched")) {
			root.classList.add("pp-booting");
			// Garantia: a splash nunca prende a tela, mesmo se pwa.js nao carregar.
			setTimeout(() => root.classList.remove("pp-booting"), 6000);
		}
	} catch {
		/* sem sessionStorage: abre direto */
	}
})();
