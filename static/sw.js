const CACHE_NAME = 'trip-planner-shell-v9';
const APP_SHELL = [
  '/', '/static/index.html', '/static/styles.css?v=budget-clarity-v2',
  '/static/app.js?v=budget-clarity-v2', '/static/offline-store.js?v=offline-v5',
  '/static/budget.js?v=budget-v6', '/static/booking.js?v=booking-v2',
  '/static/import-diff.js?v=import-v1', '/static/today.js?v=today-v3',
  '/static/timeline.js?v=schedule-modes-v5',
  '/static/map-config.js?v=map-marker-anchor-1', '/static/map-data.js?v=map-marker-anchor-1',
  '/static/map-view.js?v=map-marker-anchor-1', '/static/vendor/maplibre-gl/maplibre-gl.css',
  '/static/vendor/maplibre-gl/maplibre-gl.mjs?v=6.3.0', '/static/vendor/maplibre-gl/maplibre-gl-shared.mjs',
  '/static/vendor/maplibre-gl/maplibre-gl-worker.mjs', '/static/manifest.webmanifest',
  '/static/icons/trip-planner.svg',
];

self.addEventListener('install', event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('trip-planner-shell-') && key !== CACHE_NAME).map(key => caches.delete(key))))));

function isNavigation(request) { return request.mode === 'navigate'; }
function isShellAsset(url) { return url.origin === self.location.origin && url.pathname.startsWith('/static/'); }

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (isNavigation(request)) {
    event.respondWith(fetch(request).then(response => {
      const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put('/', copy)); return response;
    }).catch(() => caches.match(request).then(found => found || caches.match('/'))));
    return;
  }
  if (isShellAsset(url)) event.respondWith(caches.match(request).then(found => found || fetch(request)));
});
