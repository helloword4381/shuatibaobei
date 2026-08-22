// sw.js — PWA 离线缓存
const CACHE = 'shuatibaobei-v16';
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
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // GitHub 原始 / 题库 manifest：永远网络优先（保证检测到新版本的能力）
  if (url.hostname.includes('githubusercontent.com') || url.hostname.includes('gitmirror')
      || url.pathname.endsWith('/manifest.json')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // HTML：stale-while-revalidate — 先给旧缓存让页面秒开，同时后台偷偷拉新版存缓存
  // 下次进入就自然是新版（用户不用手动 Ctrl+Shift+R）
  if (req.mode === 'navigate' || url.pathname.endsWith('.html')
      || url.pathname.endsWith('/') || url.pathname === '') {
    e.respondWith(
      caches.match(req).then(hit => {
        const fetchPromise = fetch(req).then(resp => {
          if (resp.ok && url.origin === location.origin) {
            const copy = resp.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return resp;
        }).catch(() => {});
        return hit || fetchPromise;
      })
    );
    return;
  }

  // 其它静态资源（CSS/JS/WASM/图片/DB）：缓存优先，没命中再拉网络
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
