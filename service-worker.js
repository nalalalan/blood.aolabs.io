const CACHE_NAME = "blood-aolabs-20260630-rec-first-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./paper.html",
  "./paper.pdf",
  "./styles.css",
  "./app.js",
  "./icon.svg?v=20260627-suite-drop",
  "./marks/ao-ink.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
