/*
  Service worker Sayur App.
  Strategi: cache-first untuk app-shell (HTML/CSS/JS/font statis),
  network-first murni (tanpa cache) untuk semua request ke domain lain,
  termasuk API Google Apps Script — supaya data belanja/omzet selalu live.
*/

const CACHE_NAME = 'sayur-app-shell-v1';

// Sesuaikan daftar ini kalau nanti file dipecah (mis. style.css / app.js terpisah).
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

  // Jangan pernah ikut campur request ke domain lain (Google Apps Script,
  // Google Fonts, dll). Biarkan browser yang urus langsung ke network,
  // supaya data selalu fresh dan tidak ada risiko cache basi menyamar data.
  if (url.origin !== self.location.origin) return;

  // Hanya tangani GET; POST/PUT dsb (kalau ada di masa depan) lewat network biasa.
  if (req.method !== 'GET') return;

  // Stale-while-revalidate untuk file app-shell sendiri.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.ok) {
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
