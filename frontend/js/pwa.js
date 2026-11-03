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

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").then((registration) => {
        if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(worker);
          });
        });
      }).catch(() => {});
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }

  function syncOfflineBanner() {
    let banner = document.querySelector(".offline-banner");
    if (navigator.onLine) { banner?.remove(); return; }
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
