/* Shop Desk service worker.
   The app works on the shop Wi-Fi; this caches the shell so phones can reopen
   it quickly and shows a helpful page when the server is unreachable.
   API responses are never cached: stock and bills must always be live. */
const VERSION = "shopdesk-v3";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/favicon.png",
  "/fonts/noto-sans-bengali-400-normal.woff2",
  "/fonts/noto-sans-bengali-600-normal.woff2"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(new Request(url, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cache live shop data
  if (url.pathname.startsWith("/healthz")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(VERSION).then(cache => cache.put("/index.html", copy)).catch(() => {});
          return response;
        })
        .catch(async () => (await caches.match("/offline.html")) || (await caches.match("/index.html")) || Response.error())
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then(cache => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener("message", event => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
