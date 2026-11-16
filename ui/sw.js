// sw.js — keeps the page shell for an offline start. Never touches /api/ (live state, tokens, answers).
// When the server is down and the shell is not cached, it answers with a plain "decide is not running" page.

const CACHE = "decide-shell-1";
const SHELL = ["/", "/manifest.webmanifest", "/ui/icon.svg"];
const START = "node decide.mjs open";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const down = () =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>decide</title><body style="font:16px system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem"><h1>decide is not running</h1><p>Start it with:</p><pre>${START}</pre>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
  );

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cached, never answered here
  const shell = url.pathname === "/" || url.pathname.startsWith("/ui/") || url.pathname === "/manifest.webmanifest";
  if (!shell) return;
  // Network first: a running server always wins; the cache answers only when it is down.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? down() : Response.error()))),
  );
});
