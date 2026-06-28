const CACHE_NAME = 'rpro-v37';
const ASSETS = [
  './index.html',
  './manifest.json',
  './ibama.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './furgao.html',
  './cloud-sync.js',
  './decision-engine.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => Promise.all(
        ASSETS.map(a => c.add(a).catch(err => console.warn('SW: asset ignorado no cache:', a, err)))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Só intercepta o próprio app (mesma origem). APIs externas (CNPJ, mapas) vão direto pra rede.
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
