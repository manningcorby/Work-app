// App shell cache. Pages come network-first so updates land on the next open;
// the sheet's data is never cached here (the app keeps its own copy).
const VERSION = 'work-1.0.1';
const SHELL = ['./', 'index.html', 'app.css', 'popup.css', 'shim.js', 'shared.js', 'popup.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(res => { const c = res.clone(); caches.open(VERSION).then(cache => cache.put(e.request, c)); return res; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
