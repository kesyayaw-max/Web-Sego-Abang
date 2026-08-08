// RM. Sego Abang Pendopo Wonomarto — Service Worker v1.2
// Strategi: Cache First untuk aset statis, Network First untuk API.

const CACHE_NAME = 'sego-abang-v1.2';
const STATIC_CACHE = 'sego-abang-static-v1.2';
const API_CACHE = 'sego-abang-api-v1.2';

// Aset yang di-precache saat install
const PRECACHE_URLS = [
  '/index.html',
  '/customer.html',
  '/menu.html',
  '/receipt.html',
  '/track.html',
  '/login.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,500;0,600;0,700;1,500&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
];

// ─── INSTALL ──────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      // Precache masing-masing URL secara individual (jangan gagal semua jika satu error)
      await Promise.allSettled(
        PRECACHE_URLS.map(url => cache.add(url).catch(e => console.warn('[SW] Failed to precache:', url, e)))
      );
    }).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ─────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE && key !== API_CACHE)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH STRATEGY ───────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Bypass: socket.io, chrome-extension, non-GET
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/socket.io')) return;
  if (request.url.startsWith('chrome-extension')) return;

  // API calls: Network First dengan fallback cache
  if (url.hostname === 'localhost' && url.pathname.startsWith('/api')) {
    event.respondWith(networkFirstAPI(request));
    return;
  }

  // Google Fonts & CDN: Cache First
  if (url.hostname.includes('fonts.googleapis') || url.hostname.includes('fonts.gstatic') || url.hostname.includes('cdn.socket.io')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // HTML halaman & aset lokal: Stale While Revalidate
  if (url.hostname === location.hostname || url.hostname === 'localhost') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
});

// ─── STRATEGIES ───────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (_e) {
    return new Response('Offline — aset tidak tersedia', { status: 503 });
  }
}

async function networkFirstAPI(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_e) {
    const cache = await caches.open(API_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ success: false, offline: true, message: 'Tidak ada koneksi internet.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || await fetchPromise || new Response('Halaman tidak tersedia offline.', { status: 503 });
}

// ─── PUSH NOTIFICATIONS ───────────────────────────────────────────────
// (Siap untuk diaktifkan jika backend mendukung Web Push)
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'RM. Sego Abang Pendopo Wonomarto', {
        body: data.body || 'Ada update baru.',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.tag || 'sego-abang',
        data: { url: data.url || '/admin-dashboard.html' },
        vibrate: [200, 100, 200],
      })
    );
  } catch(e) {
    console.warn('[SW] Push notification error:', e);
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
