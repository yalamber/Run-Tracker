// OpenSplits Live service worker: offline app shell, never caches live data.
const VERSION = 'v1';
const CACHE = `opensplits-${VERSION}`;
const SHELL = [
  '/',
  '/run',
  '/track.html',
  '/css/style.css',
  '/js/core.js',
  '/js/common.js',
  '/js/ui.js',
  '/js/map.js',
  '/js/home.js',
  '/js/runner.js',
  '/js/viewer.js',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/leaflet.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('opensplits-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return; // map tiles etc. go straight to network
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return; // always live

  if (request.mode === 'navigate') {
    // Network first so deploys show up immediately; fall back to the cached shell offline.
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          if (url.pathname.startsWith('/t/')) return caches.match('/track.html');
          if (url.pathname.startsWith('/run')) return caches.match('/run');
          return caches.match('/');
        }),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
