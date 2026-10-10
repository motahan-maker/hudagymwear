/* HUDA GYMWEAR — Brand Studio service worker.
 * Goals: installable PWA, fast cold starts on phones, and an admin that opens
 * (read-only) even with no signal. Rules:
 *   - HTML navigations: network-first, cached as fallback (last version seen).
 *   - Static assets (hashed js/css/images/fonts): stale-while-revalidate.
 *   - Anything else (server functions, Supabase, Google APIs): network only,
 *     never cached — realtime/data must never come from a cache.
 */

const VERSION = 'huda-bs-v1';
const STATIC_CACHE = `${VERSION}-static`;
const NAV_CACHE = `${VERSION}-nav`;
const PRECACHE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png', '/favicon.png'];
const STATIC_RE = /\.(?:js|css|png|jpe?g|webp|avif|svg|ico|woff2?|gif|manifest|webmanifest)(?:\?|$)/i;
const NAV_MAX = 12;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isStaticAsset(url) {
  return url.origin === self.location.origin && STATIC_RE.test(url.pathname);
}

function isNavigation(event) {
  return event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html');
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map((req) => cache.delete(req)));
}

async function networkFirst(event) {
  const { request } = event;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200 && fresh.type === 'basic') {
      const copy = fresh.clone();
      event.waitUntil(caches.open(NAV_CACHE).then(async (cache) => {
        await cache.put(request, copy);
        await trimCache(NAV_CACHE, NAV_MAX);
      }));
    }
    return fresh;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const shell = await caches.match('/');
    if (shell) return shell;
    return new Response(
      `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline — HUDA Brand Studio</title>
<style>body{font-family:system-ui,sans-serif;background:#6d1f2c;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}h1{font-size:22px}p{opacity:.8;font-size:14px}button{background:#fff;color:#6d1f2c;border:0;padding:12px 22px;font:inherit;font-weight:700;cursor:pointer}</style>
</head><body><div><h1>No signal right now</h1><p>Reconnect and try again — new orders keep ringing as soon as realtime is back.</p><button onclick="location.reload()">TRY AGAIN</button></div></body></html>`,
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
  }
}

async function staleWhileRevalidate(event) {
  const { request } = event;
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.status === 200 && (res.type === 'basic' || res.type === 'opaque')) {
        cache.put(request, res.clone());
      }
      return res;
    })
    .catch(() => undefined);
  return cached ?? (await network) ?? Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // server functions, auth, uploads — always live
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // supabase, fonts, etc: never touch
  if (url.pathname.startsWith('/api/') || url.pathname.includes('serverFn')) return;

  if (isNavigation(event)) {
    event.respondWith(networkFirst(event));
  } else if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(event));
  }
});

// Tapping a phone notification opens/focuses the right admin screen.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/admin';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({ type: 'huda:alert-open', link });
          return client.focus();
        }
      }
      return self.clients.openWindow(link);
    })
  );
});
