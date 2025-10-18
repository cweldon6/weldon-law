const CACHE = 'wl-static-v1';

const PRECACHE = [
  '/', '/index.html', '/about.html', '/contact.html', '/privacy.html',
  '/practice-guardianships.html', '/practice-ltc.html', '/practice-lp.html',
  '/practice-legacy.html', '/practice-probate.html', '/practice-general.html',
  '/branded-styles.css',
  '/assets/site.js', '/assets/js/main.js', '/assets/js/js/modules/forms.js',
  '/images/WeldonLawLogoG.png',
  '/offline.html',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Navigation: network-first with offline fallback
// Static assets: stale-while-revalidate
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Let non-GET requests pass through (e.g., form POST to Power Automate)
  if (req.method !== 'GET') return;

  // Allow cross-origin requests to proceed without SW handling
  if (url.origin !== location.origin) return;

  // HTML navigations
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // Static assets
  if (/\.(?:css|js|png|jpg|jpeg|svg|webp|ico)$/i.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((res) => {
            cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Default: network with cache fallback
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
