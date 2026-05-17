// TE NIMS · FOB — Service Worker
//
// Caches the static page + all dependencies the first time they're fetched.
// On subsequent loads (or with no internet), all assets serve from the
// cache instantly. The /tts and /tiles endpoints + Ollama API are NEVER
// cached — they're dynamic / size-prohibitive / device-local.
//
// Per the offline-first FOB tier guarantee, this is the safety net so the
// page works even if every CDN goes dark.

const CACHE_NAME = "te-nims-fob-v29";  // bump to invalidate stale app.js / chain.js / etc.
const PRECACHE_PATHS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/config.js",
  "/map.js",
  "/form.js",
  "/chain.js",
  "/voice.js",
  "/persistence.js",
  "/library.js",
  "/manifest.json",
];

// External CDN deps the page imports (marked, leaflet). Cached on first
// fetch via runtime caching below — not precached because their URLs
// include version pins that should stay current per release.

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_PATHS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Drop old cache versions so a new release rolls out cleanly
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Cache API only supports http/https — skip chrome-extension:// and others.
  if (!event.request.url.startsWith("http")) return;

  const url = new URL(event.request.url);

  // Don't cache: dynamic endpoints, Ollama (direct or proxied), anything POSTed
  const isDynamic =
    url.pathname.startsWith("/tts") ||
    url.pathname.startsWith("/tiles/") ||  // tiles already cached by browser HTTP cache
    url.pathname.startsWith("/api/ollama/") ||  // serve.py Ollama proxy — never cache
    url.port === "11434" || url.port === "11500" ||
    event.request.method !== "GET";

  if (isDynamic) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response("", { status: 503, statusText: "Service Unavailable" })
      )
    );
    return;
  }

  // Strategy:
  //   - Same-origin (our HTML/CSS/JS): NETWORK-FIRST, cache fallback. Means
  //     edits to app.js / chain.js / form.js etc. land on the next reload
  //     without a cache-bust. Stays offline-capable via the cache fallback.
  //   - CDN deps (marked, leaflet): CACHE-FIRST (they have version pins,
  //     the cached copy is correct).
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    event.respondWith(
      fetch(event.request).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
        }
        return resp;
      }).catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        if (url.pathname.endsWith(".html") || url.pathname === "/") {
          return caches.match("/index.html").then((r) => r || new Response("", { status: 503, statusText: "Offline" }));
        }
        return new Response("offline", { status: 503, statusText: "Offline" });
      }))
    );
    return;
  }

  // Cross-origin (CDN libs) — cache-first with populate-on-fetch
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp.ok && (resp.type === "basic" || resp.type === "cors")) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
        }
        return resp;
      });
    })
  );
});
