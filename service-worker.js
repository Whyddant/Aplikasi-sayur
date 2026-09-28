/*
  Service worker Sayur App.
  Strategi:
  - Halaman utama (HTML / navigasi): network-first, jatuh ke cache kalau offline.
    Jadi versi baru index.html langsung tampil begitu aplikasi dibuka.
  - File statis lain milik sendiri (manifest, ikon): stale-while-revalidate.
  - Semua request ke domain lain (Google Apps Script, Google Fonts, dll):
    tidak disentuh sama sekali, supaya data belanja/omzet selalu live.
*/

// Naikkan angka versi ini setiap kali ada perubahan besar pada app-shell.
const CACHE_NAME = 'sayur-app-shell-v2';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') return;

  const isHtml = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');

  if (isHtml){
    // Network-first: ambil versi terbaru; kalau gagal (offline) pakai cache.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok){
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  // File statis lain: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.ok){
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
