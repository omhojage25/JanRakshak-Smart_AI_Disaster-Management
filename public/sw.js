// JanRakshak service worker: keeps the app shell and viewed map tiles available offline.
// API calls are never cached; offline report capture is handled by the page (IndexedDB queue).
const VERSION = 'v1';
const SHELL_CACHE = `jr-shell-${VERSION}`;
const ASSET_CACHE = `jr-assets-${VERSION}`;
const TILE_CACHE = `jr-tiles-${VERSION}`;
const MAX_TILES = 800;
const MAX_ASSETS = 80;

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  const res = await fetch('/', { cache: 'no-store' });
  if (!res.ok) return;
  const html = await res.clone().text();
  await cache.put('/', res);
  // Cache the bundles referenced by the current build so a reload works offline.
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  const assetCache = await caches.open(ASSET_CACHE);
  await Promise.all(assets.map((url) => assetCache.add(url).catch(() => {})));
  await Promise.all(['/manifest.webmanifest', '/icon.svg'].map((url) => cache.add(url).catch(() => {})));
}

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE, TILE_CACHE]);
    for (const key of await caches.keys()) {
      if (key.startsWith('jr-') && !keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin && (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io'))) {
    return;
  }

  // Page navigations: network first so deployments show up immediately, cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL_CACHE)).put('/', res.clone());
        return res;
      } catch {
        return (await caches.match('/')) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // Hashed build assets never change: cache first.
  if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(ASSET_CACHE);
        await cache.put(req, res.clone());
        trim(ASSET_CACHE, MAX_ASSETS);
      }
      return res;
    })());
    return;
  }

  // Map tiles: serve from cache when available, refresh in the background.
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(async (res) => {
        if (res.ok || res.type === 'opaque') {
          await cache.put(req, res.clone());
          trim(TILE_CACHE, MAX_TILES);
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
    return;
  }

  // Fonts and other same-origin static files: stale-while-revalidate.
  if (url.hostname.includes('fonts.g') || url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});
