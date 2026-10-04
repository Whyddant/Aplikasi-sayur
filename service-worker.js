/* ==========================================================
   SAYUR APP — service-worker.js (v5.0)
   
   Strategi:
   - HTML/navigasi: network-first, fallback cache
   - Static assets: stale-while-revalidate
   - API (Google Apps Script): selalu network, tidak di-cache
     (karena SayurStorage sudah handle cache di localStorage)
   ========================================================== */

const CACHE_VERSION = 'sayur-v8';
const APP_SHELL = [
  './',
  './index.html',
  './storage.js',
  './manifest.json',
  './nota.html',
  './pengaturan.html',
  './panduan.html',
  './tentang.html',
  './bantuan.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

/* ==========================================================
   INSTALL — cache app shell
   ========================================================== */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => {
        /* addAll berhenti kalau 1 file gagal — pakai add satu-satu
           supaya tetap lanjut meskipun ada yang 404 (misal icon belum ada) */
        return Promise.all(
          APP_SHELL.map(url =>
            cache.add(url).catch(err =>
              console.warn('Gagal cache:', url, err))
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

/* ==========================================================
   ACTIVATE — hapus cache lama
   ========================================================== */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ==========================================================
   FETCH — strategi per tipe request
   ========================================================== */
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  /* Skip non-GET */
  if(req.method !== 'GET') return;

  /* ========================================================
     API Google Apps Script — jangan di-cache di service worker
     (SayurStorage sudah punya cache sendiri di localStorage)
     ======================================================== */
  if(url.hostname.includes('script.google.com') ||
     url.hostname.includes('script.googleusercontent.com')){
    return; // biarkan fetch lewat normal
  }

  /* ========================================================
     Cross-origin lain (font, dll) — biarkan browser handle
     ======================================================== */
  if(url.origin !== self.location.origin) return;

  /* ========================================================
     HTML / navigasi — network-first
     ======================================================== */
  const isHtml = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if(isHtml){
    event.respondWith(
      fetch(req)
        .then(res => {
          if(res && res.ok){
            const clone = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then(c => c || caches.match('./index.html'))
        )
    );
    return;
  }

  /* ========================================================
     Static assets — stale-while-revalidate
     ======================================================== */
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(res => {
          if(res && res.ok){
            const clone = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

/* ==========================================================
   MESSAGE — kontrol dari app (opsional)
   ========================================================== */
self.addEventListener('message', event => {
  if(event.data === 'SKIP_WAITING'){
    self.skipWaiting();
  }
  if(event.data === 'CLEAR_CACHE'){
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => {
      event.ports[0]?.postMessage({ok: true});
    });
  }
});