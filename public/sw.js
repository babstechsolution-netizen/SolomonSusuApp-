/* Awinbire Enterprise — Service Worker (minimal + safe)
 * Only caches the static app shell so the app can open offline.
 * It NEVER intercepts API calls (/api/) or real-time traffic (/socket.io/) —
 * those always go straight to the network, so data and live sync are never affected.
 * Bump CACHE_VERSION to force a refresh of cached assets.
 */
const CACHE_VERSION = 'awinbire-v2';
const SHELL = ['/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                    // never touch POST/PATCH/DELETE
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // let cross-origin (fonts/CDN) pass through
  if (url.pathname.startsWith('/api/')) return;        // API always straight to network
  if (url.pathname.startsWith('/socket.io/')) return;  // real-time always straight to network

  // App pages: network-first so you always get the latest app; cached shell only when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }

  // Static same-origin assets (icons, manifest): cache-first, refresh in background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
