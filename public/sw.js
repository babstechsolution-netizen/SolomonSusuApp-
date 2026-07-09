/* Awinbire Enterprise — minimal, safe service worker (makes the app installable).
 * It ONLY caches the static app shell so the app opens instantly / offline.
 * It NEVER intercepts /api/ or /socket.io/ — data and realtime always go straight
 * to the network. Navigations are network-first, so online users always get the
 * latest app. Bump CACHE_VERSION to refresh cached assets. */
const CACHE_VERSION = 'awinbire-v3';
const SHELL = ['/app.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

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
  if (req.method !== 'GET') return;                    // never touch writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // let CDN/fonts pass through
  if (url.pathname.startsWith('/api/')) return;        // data always straight to network
  if (url.pathname.startsWith('/socket.io/')) return;  // realtime always straight to network

  // App pages: network-first so you always get the newest app; cached shell only offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/app.html')));
    return;
  }

  // Static same-origin assets (icons/manifest): cache-first, refresh in background.
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
