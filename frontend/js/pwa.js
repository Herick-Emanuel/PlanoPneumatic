(() => {
	if (window.__pwaInitialized) return;
	window.__pwaInitialized = true;

	function showUpdateBanner(worker) {
		if (document.querySelector(".update-banner")) return;
		const banner = document.createElement("div");
		banner.className = "update-banner";
		banner.setAttribute("role", "status");
		banner.innerHTML = '<span>Nova versão disponível.</span><button type="button">Atualizar agora</button>';
		banner.querySelector("button").addEventListener("click", () => worker.postMessage({ type: "SKIP_WAITING" }));
		document.body.appendChild(banner);
	}

	const root = document.documentElement;
	const booting = root.classList.contains("pp-booting");
	const finishSplash = () => root.classList.remove("pp-booting");
	try {
		sessionStorage.setItem("pp-launched", "1");
	} catch {
		/* sem sessionStorage */
	}
	// Espera um worker novo chegar a "installed" (ou desistir no prazo).
	const waitInstalled = (worker, timeout) =>
		new Promise((resolve) => {
			if (!worker) return resolve(null);
			if (worker.state === "installed") return resolve(worker);
			const timer = setTimeout(() => resolve(null), timeout);
			worker.addEventListener("statechange", () => {
				if (worker.state === "installed") {
					clearTimeout(timer);
					resolve(worker);
				} else if (worker.state === "redundant") {
					clearTimeout(timer);
					resolve(null);
				}
			});
		});

	// Na abertura (splash visivel): procura versao nova no servidor e, se houver, ativa e recarrega
	// antes de mostrar o app. Sem internet ou sem resposta em 4 s, abre a versao em cache.
	async function updateOnLaunch(registration) {
		const deadline = Date.now() + 4000;
		try {
			let worker = registration.waiting;
			if (!worker) {
				await Promise.race([registration.update(), new Promise((resolve) => setTimeout(resolve, 3000))]);
				worker = registration.waiting || (await waitInstalled(registration.installing, Math.max(0, deadline - Date.now())));
			}
			if (worker) {
				root.classList.add("pp-updating");
				worker.postMessage({ type: "SKIP_WAITING" }); // controllerchange recarrega a tela
				setTimeout(finishSplash, 3000);
				return;
			}
		} catch {
			/* offline ou servidor fora: segue com o cache */
		}
		finishSplash();
	}

	if ("serviceWorker" in navigator) {
		const start = () =>
			navigator.serviceWorker
				.register("/sw.js")
				.then((registration) => {
					if (booting && navigator.serviceWorker.controller) return updateOnLaunch(registration);
					// Durante o uso: a versao nova espera e o aviso deixa a pessoa escolher a hora (nao perde formulario).
					if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner(registration.waiting);
					registration.addEventListener("updatefound", () => {
						const worker = registration.installing;
						worker?.addEventListener("statechange", () => {
							if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(worker);
						});
					});
					return null;
				})
				.catch(finishSplash);
		// Na abertura nao espera o "load" (imagens): quanto antes checar, menos tempo de splash.
		if (booting) start();
		else window.addEventListener("load", start);
		let reloading = false;
		navigator.serviceWorker.addEventListener("controllerchange", () => {
			if (reloading) return;
			reloading = true;
			window.location.reload();
		});
	}

	function syncOfflineBanner() {
		let banner = document.querySelector(".offline-banner");
		if (navigator.onLine) {
			banner?.remove();
			return;
		}
		if (!banner) {
			banner = document.createElement("div");
			banner.className = "offline-banner";
			banner.setAttribute("role", "status");
			banner.textContent = "Você está offline. Formulários preenchidos serão enviados quando a conexão voltar.";
			document.body.prepend(banner);
		}
	}
	window.addEventListener("online", syncOfflineBanner);
	window.addEventListener("offline", syncOfflineBanner);
	window.addEventListener("load", syncOfflineBanner);

	window.__pwaInstallPrompt = null;
	window.addEventListener("beforeinstallprompt", (event) => {
		event.preventDefault();
		window.__pwaInstallPrompt = event;
		window.dispatchEvent(new CustomEvent("pwa-install-available"));
	});

	window.addEventListener("appinstalled", () => {
		window.__pwaInstallPrompt = null;
		window.dispatchEvent(new CustomEvent("pwa-installed"));
	});
})();
