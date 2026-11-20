/* Оболочка приложения в офлайн-кэше. Данные каталога кэшируются в localStorage.
   Стратегия: документ и код (js/css) — сеть-первым, чтобы обновления доезжали сразу;
   остальное — из кэша с фоновым обновлением. */
const CACHE = 'polka-shell-v15';
const MEDIA_CACHE = 'polka-media';      // аудио, скачанное для офлайна
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.pathname === '/api' || url.pathname === '/healthz') return;   // данные каталога — только сеть

  // Аудио с CDN: если глава скачана для офлайна — играем из кэша, без сети.
  if (url.origin !== location.origin) {
    if (req.destination === 'audio' || /\.(mp3|m4a|aac|ogg|opus|wav)$/i.test(url.pathname)) {
      e.respondWith(
        caches.open(MEDIA_CACHE).then(c => c.match(req).then(hit => hit || fetch(req)))
      );
    }
    return;   // остальное (обложки CDN) — мимо кэша
  }

  // Документ и код приложения (js/css): всегда пробуем сеть, при отсутствии — кэш.
  if (req.mode === 'navigate' || req.destination === 'document' || req.destination === 'script' || req.destination === 'style') {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
    );
    return;
  }

  // Ресурсы: отдаём из кэша сразу, обновляем в фоне.
  e.respondWith(
    caches.match(req).then(hit => {
      const network = fetch(req).then(res => {
        if (res && res.ok && res.type === 'basic') caches.open(CACHE).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || network;
    })
  );
});
