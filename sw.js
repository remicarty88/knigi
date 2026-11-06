const CACHE = 'books-v21';
const SHELL = ['/', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname === '/api/img') { // обложки: сначала кэш устройства (мгновенно), иначе сеть и запоминаем
    e.respondWith(caches.open('covers-v1').then(async c => {
      const m = await c.match(e.request); if (m) return m;
      const r = await fetch(e.request);
      if (r.ok) { c.put(e.request, r.clone()); c.keys().then(k => k.length > 500 && c.delete(k[0])); }
      return r;
    }));
    return;
  }
  if (u.pathname.startsWith('/api/')) return; // остальной API — только сеть
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
