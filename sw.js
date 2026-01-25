// HOME TV Service Worker v3.0
const CACHE_NAME = 'hometv-v3.1';
const STATIC_ASSETS = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './db.js',
    './icon.png',
    './manifest.json'
];

// External dependencies to cache
const CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/hls.js@latest',
    'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch event - Stale-While-Revalidate for static, Network-First for interactions
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    // Skip streaming URLs (m3u8, ts segments, playlist updates)
    if (url.pathname.endsWith('.m3u8') ||
        url.pathname.endsWith('.ts') ||
        url.pathname.endsWith('.m3u') ||
        url.hostname.includes('iptv')) {
        return;
    }

    // JSON Data / API calls -> Network First (Freshness priority)
    if (url.pathname.endsWith('.json')) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }

    // Static Assets (CSS, JS, Fonts, HTML) -> Stale-While-Revalidate
    // Fastest load time, updates in background for next visit
    event.respondWith(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.match(event.request).then((cachedResponse) => {
                const fetchPromise = fetch(event.request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        cache.put(event.request, networkResponse.clone());
                    }
                    return networkResponse;
                }).catch(() => {
                    // Offline fallback
                    if (event.request.mode === 'navigate') {
                        return cache.match('./index.html');
                    }
                });
                return cachedResponse || fetchPromise;
            });
        })
    );
});

// Handle messages from main thread
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});
