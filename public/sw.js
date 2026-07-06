/* Awinbire Enterprise — Service Worker
 * Conservative + network-first: when online you always get the latest app and fresh data
 * from the server. The cache is only ever used as a fallback when there is no connection.
 * Bump CACHE_VERSION on each release to purge old caches.
 */
const CACHE_VERSION = 'awinbire-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(flushQueue)
  );
});

// ---- Minimal IndexedDB queue for transactions recorded while offline ----
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('awinbire-queue', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('txns', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function qAdd(item) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('txns', 'readwrite');
    tx.objectStore('txns').put(item);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function qAll() {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction('txns', 'readonly').objectStore('txns').getAll();
    r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
  });
}
async function qDel(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('txns', 'readwrite');
    tx.objectStore('txns').delete(key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

// Replay queued transactions. idempotencyKey makes re-sends safe (server returns the original).
async function flushQueue() {
  let items;
  try { items = await qAll(); } catch { return; }
  for (const item of items) {
    try {
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: item.headers,
        body: JSON.stringify(item.body),
      });
      if (res.ok || res.status === 409) await qDel(item.key);
    } catch (e) {
      // still offline — stop; we'll retry on next sync/online
      break;
    }
  }
  // Tell open pages the queue changed so they can refresh
  const clients = await self.clients.matchAll();
  clients.forEach((c) => c.postMessage({ type: 'queue-flushed' }));
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-transactions') event.waitUntil(flushQueue());
});
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'flush-queue') flushQueue();
});

// ---- Fetch strategy ----
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Offline queue: a deposit/withdrawal recorded with no connection is saved and replayed later.
  if (req.method === 'POST' && url.pathname === '/api/transactions') {
    event.respondWith(queueingPost(req));
    return;
  }

  // Only GET requests are cached.
  if (req.method !== 'GET') return;

  // App pages (navigations): network-first so you always get the newest app; cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // API data: network-first, fall back to the last cached copy when offline.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Everything else (app JS/CSS/fonts, icons): stale-while-revalidate for fast, offline-capable loads.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

async function queueingPost(req) {
  try {
    return await fetch(req.clone());
  } catch (e) {
    // No connection — queue it with an idempotency key and reassure the user.
    try {
      const body = await req.clone().json();
      if (!body.idempotencyKey) {
        body.idempotencyKey = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      }
      const headers = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      headers['Content-Type'] = 'application/json';
      await qAdd({ key: body.idempotencyKey, body, headers });
      if ('sync' in self.registration) {
        try { await self.registration.sync.register('sync-transactions'); } catch {}
      }
      return new Response(
        JSON.stringify({ success: false, queued: true, message: 'Saved offline — it will sync automatically when you reconnect.' }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ success: false, message: 'You are offline and this could not be saved.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }
}
