// O marcador de ID do build abaixo e substituido no build/deploy (Dockerfile.frontend e rota /sw.js do Express): cada deploy gera um cache novo.
const CACHE_VERSION = "pp-shell-__BUILD_ID__";
const APP_SHELL = [
  "/",
  "/manifest.json",
  "/css/base.css",
  "/css/dashboard.css",
  "/css/triagem.css",
  "/css/process.css",
  "/css/historico.css",
  "/css/admin.css",
  "/js/api.js",
  "/js/shell-tools.js",
  "/js/shared-shell.js",
  "/css/ui.css",
  "/js/app.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/logo.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
  );
});

// A nova versao fica em espera ate o usuario aceitar o aviso "nova versao disponivel".
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
