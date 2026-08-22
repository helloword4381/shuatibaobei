// sw.js — PWA 离线缓存
const CACHE = 'shuatibaobei-v6';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './js/sql-wasm.js',
  './js/sql-wasm.wasm',
  './js/db.js',
  './js/store.js',
  './js/app.js',
  './shuatibaobei.db',
  './manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // GitHub 原始资源：不走缓存（保证能取到最新）
  if (url.hostname.includes('githubusercontent.com') || url.hostname.includes('gitmirror')) {
    e.respondWith(fetch(req)); return;
  }
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      if (resp.ok && url.origin === location.origin) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return resp;
    }).catch(() => caches.match(req)))
  );
});
