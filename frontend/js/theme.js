// Carregado no <head> (sem defer) para aplicar tema e menu recolhido antes da primeira pintura.
(() => {
	const root = document.documentElement;
	try {
		const theme = localStorage.getItem("pp-theme");
		if (theme === "light" || theme === "dark") root.dataset.theme = theme;
		if (localStorage.getItem("pp-sidebar") === "collapsed") root.classList.add("sidebar-collapsed");
	} catch { /* armazenamento indisponivel: segue o tema do sistema */ }
})();
