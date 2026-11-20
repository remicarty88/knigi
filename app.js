/* =============================================================
   Полка — каталог аудиокниг (мобильное веб-приложение)
   Поток данных: список/жанры/поиск -> m-каталог, книга -> страница с плейлистом.
   Аудио играется напрямую с CDN источника (без промежуточных серверов).
   ============================================================= */

/* ---------- 1. Конфигурация ---------- */

const SRC = {
  list: 'https://m.knigavuhe.org', // каталог, жанры, поиск (серверный HTML)
  book: 'https://knigavuhe.org',   // страница книги (с плейлистом mp3)
};

// Второй источник — читабельные книги (текст). Идёт параллельно аудиокаталогу.
const SRC_READ = 'https://loveread.ec';

// Единственная точка подключения шлюза — наш сервер (server.js): он отдаёт
// статику и проксирует источники через /api?u=… (у них нет CORS-заголовков).
const GATE = url => '/api?u=' + encodeURIComponent(url);

const TTL = { list: 15 * 60e3, genres: 24 * 3600e3, search: 5 * 60e3, book: 30 * 60e3, lr: 20 * 60e3, lrbook: 60 * 60e3, lrpage: 7 * 24 * 3600e3 };

/* ---------- 2. Утилиты ---------- */

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

function durationToSec(str) {                       // "3:58:37" -> секунды
  if (!str) return 0;
  const p = String(str).trim().split(':').map(Number).reverse();
  return (p[0] || 0) + (p[1] || 0) * 60 + (p[2] || 0) * 3600;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
}

/* ---------- 3. Кэш ---------- */

const store = {
  get(key) {
    try {
      const raw = JSON.parse(localStorage.getItem('polka:' + key));
      if (!raw || Date.now() > raw.e) return null;
      return raw.d;
    } catch { return null; }
  },
  // Данные из кэша независимо от срока хранения — выручает, когда источник
  // недоступен (нет сети или источник нас ограничил).
  getStale(key) {
    try {
      const raw = JSON.parse(localStorage.getItem('polka:' + key));
      return raw ? raw.d : null;
    } catch { return null; }
  },
  set(key, data, ttl) {
    try { localStorage.setItem('polka:' + key, JSON.stringify({ e: Date.now() + ttl, d: data })); }
    catch {
      // переполнение хранилища — чистим кэш каталога
      Object.keys(localStorage).filter(k => k.startsWith('polka:list:')).forEach(k => localStorage.removeItem(k));
    }
  },
  drop(prefix) {
    Object.keys(localStorage).filter(k => k.startsWith('polka:' + prefix)).forEach(k => localStorage.removeItem(k));
  },
};

/* ---------- 3.5 Кэш офлайн-контента (Cache API) ---------- */
/* Скачанные аудиокниги лежат в polka-media, страницы читалки — в polka-data. */

const MEDIA_CACHE = 'polka-media';
const DATA_CACHE = 'polka-data';

async function cachePutText(name, key, text) {
  try {
    const c = await caches.open(name);
    await c.put(new Request(key), new Response(text, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    return true;
  } catch { return false; }
}

async function cacheGetText(name, key) {
  try {
    const c = await caches.open(name);
    const hit = await c.match(new Request(key));
    return hit ? await hit.text() : null;
  } catch { return null; }
}

/* ---------- 4. Сеть ---------- */

const inflight = new Map();

async function fetchText(url) {
  if (inflight.has(url)) return inflight.get(url);

  const job = (async () => {
    const target = GATE(url);
    let last = null;
    // До трёх попыток: источник иногда отвечает ошибкой / не успевает,
    // особенно когда параллельно идёт воспроизведение аудио.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(500 * attempt);
      try {
        // Основной запрос с заголовком формата; при сбое preflight — повтор без него.
        let r = await fetch(target, { headers: { 'X-Return-Format': 'html' } });
        if (!r.ok) r = await fetch(target);
        if (r.ok) return r.text();
        last = new Error(r.status === 429 ? 'limit' : 'net' + r.status);
        if (r.status === 429) break;   // превышен лимит — мгновенный повтор только навредит
      } catch { last = new Error('net'); }
    }
    throw last || new Error('net');
  })();

  inflight.set(url, job);
  try { return await job; }
  finally { inflight.delete(url); }
}

/* ---------- 5. Разбор страниц ---------- */

function toDoc(html) { return new DOMParser().parseFromString(html, 'text/html'); }

const slugFrom = path => String(path || '').split('/').filter(Boolean).pop() || '';

/* Обложки источника: /covers/{id}/{n}-1.jpg — маленькие (154px).
   Доступны варианты крупнее: -4.jpg (270px) и оригинал {n}.jpg (~1800px).
   kind: 'grid' — компактная для карточек, 'full' — оригинал для крупных экранов. */
function coverImg(src, kind = 'grid') {
  const s = String(src || '');
  const m = /^(.*\/covers\/\d+\/\d+)(?:-\d+)?\.jpg(\?.*)?$/i.exec(s);
  if (!m) return s;
  return kind === 'full' ? m[1] + '.jpg' : m[1] + '-4.jpg?v=1';
}

function parseListing(html) {
  const doc = toDoc(html);
  const items = [...doc.querySelectorAll('.bookkitemm')].map(el => {
    const link = el.querySelector('a.bookkitem_cover');
    const path = link?.getAttribute('href') || el.querySelector('a[href^="/book/"]')?.getAttribute('href') || '';
    const authorBlock = el.querySelector('.bookkitem_icon.-author')?.parentElement;
    const readerBlock = el.querySelector('.bookkitem_icon.-reader')?.parentElement;
    return {
      id: (el.id || '').replace('book', ''),
      slug: slugFrom(path),
      title: (el.querySelector('a.bookkitem_name') || el.querySelector('.bookkitem_name'))?.textContent.trim() || '',
      author: authorBlock?.querySelector('a')?.textContent.trim() || '',
      reader: (readerBlock?.querySelector('a.with_icon') || readerBlock?.querySelector('a'))?.textContent.trim() || '',
      genre: el.querySelector('.bookkitem_genre a')?.textContent.trim() || '',
      genreSlug: slugFrom(el.querySelector('.bookkitem_genre a')?.getAttribute('href') || ''),
      cover: el.querySelector('.bookkitem_cover_img')?.getAttribute('src') || '',
      time: el.querySelector('.bookkitem_meta_time')?.textContent.trim() || '',
    };
  });
  const totalRaw = doc.querySelector('.page_title b')?.textContent.replace(/\D/g, '');
  return { items, total: totalRaw ? Number(totalRaw) : null };
}

function parseGenres(html) {
  return [...toDoc(html).querySelectorAll('.genre_item')].map(a => ({
    slug: slugFrom(a.getAttribute('href') || ''),
    name: a.querySelector('.genre_item_name')?.textContent.trim() || '',
    count: a.querySelector('.genre_item_count')?.textContent.trim() || '',
  })).filter(g => g.slug && g.name);
}

function extractPlaylist(html) {                     // new BookPlayer(id, [ ... ])
  const at = html.indexOf('new BookPlayer(');
  if (at < 0) return null;
  const start = html.indexOf('[', at);
  if (start < 0) return null;
  let depth = 0, str = false, slash = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (str) {
      if (slash) slash = false;
      else if (c === '\\') slash = true;
      else if (c === '"') str = false;
    } else if (c === '"') str = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (!depth) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

function cleanText(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  return clone.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function parseBook(html, fallback = {}) {
  const doc = toDoc(html);
  const playlist = extractPlaylist(html) || [];
  const pd = (playlist[0] && playlist[0].player_data) || {};

  const times = [...doc.querySelectorAll('.book_playlist_item_time')].map(e => e.textContent.trim());
  const chapters = playlist.map((f, i) => ({
    id: f.id,
    title: (f.title || ('Глава ' + (i + 1))).trim(),
    url: f.url,
    duration: durationToSec(times[i] || ''),
  }));

  const authors = [...doc.querySelectorAll('[itemprop="author"] a')].map(a => a.textContent.trim()).filter(Boolean);
  const readers = [...doc.querySelectorAll('h1 .single_reader a.with_icon')].map(a => a.textContent.trim()).filter(Boolean);
  const durMatch = html.match(/Время звучания:<\/span>\s*([\d:]+)/);

  return {
    id: (html.match(/new BookPlayer\((\d+)/) || [, fallback.id])[1],
    slug: fallback.slug || '',
    title: doc.querySelector('.book_title_name')?.textContent.trim() || pd.title || fallback.title || '',
    authors: authors.length ? authors : (pd.authors ? [pd.authors] : (fallback.author ? [fallback.author] : [])),
    readers: readers.length ? readers : (pd.readers ? [pd.readers] : (fallback.reader ? [fallback.reader] : [])),
    genre: doc.querySelector('.book_genre_pretitle a')?.textContent.trim() || fallback.genre || '',
    cover: doc.querySelector('.book_cover img')?.getAttribute('src') || pd.cover || fallback.cover || '',
    duration: durMatch ? durMatch[1] : '',
    rating: doc.querySelector('meta[itemprop="ratingValue"]')?.getAttribute('content') || '',
    ratingCount: doc.querySelector('meta[itemprop="ratingCount"]')?.getAttribute('content') || '',
    description: cleanText(doc.querySelector('.book_description')),
    chapters,
  };
}

/* ---------- 6. Разбор LoveRead (читабельные книги) ---------- */

// Обложки источника отдаются относительным путём img/book_covers/... — достраиваем до абсолютного.
const lrCover = src => {
  const s = String(src || '');
  if (!s) return '';
  return /^https?:/i.test(s) ? s : SRC_READ + '/' + s.replace(/^\//, '');
};

// Значение поля в блоке характеристик: <span>Время чтения: </span>5 ч 24 мин<br>
function lrField(scope, label) {
  if (!scope) return '';
  const span = [...scope.querySelectorAll('span')]
    .find(s => s.textContent.trim().replace(/\s*:\s*$/, '') === label);
  if (!span) return '';
  let out = '', node = span.nextSibling, guard = 0;
  while (node && guard++ < 8) {
    if (node.nodeType === 3) out += node.textContent; else break;
    node = node.nextSibling;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function parseLrList(html) {
  const doc = toDoc(html);
  return [...doc.querySelectorAll('.blockBook')].map(el => {
    const about = el.querySelector('.blAboutBook');
    const link = el.querySelector('.blRead a') || el.querySelector('a[href*="book-comments.php"]') || el.querySelector('a[href*="read_book.php"]');
    const id = ((link?.getAttribute('href') || '').match(/[?&](?:book|id)=(\d+)/) || [])[1] || '';
    const genres = [...el.querySelectorAll('.blGenres a')].map(a => a.textContent.replace(/[«»]/g, '').trim()).filter(Boolean);
    return {
      id,
      title: el.querySelector('.blNameBook h3, .blNameBook h2')?.textContent.trim() || '',
      author: about?.querySelector('a[href*="biography-author"] strong, a[href*="biography-author"]')?.textContent.trim() || '',
      genre: genres[0] || '',
      cover: about?.querySelector('img.book-cover')?.getAttribute('src') || '',
      time: lrField(about, 'Время чтения'),
    };
  }).filter(b => b.id && b.title);
}

function parseLrGenres(html) {
  const menu = toDoc(html).querySelector('ul.leftMenu');
  if (!menu) return [];
  return [...menu.children].filter(li => li.tagName === 'LI').map(li => ({
    id: ((li.querySelector(':scope > a')?.getAttribute('href') || '').match(/genres=(\d+)/) || [])[1] || '',
    name: li.querySelector(':scope > a')?.textContent.trim() || '',
    subs: [...li.querySelectorAll(':scope > ul li a')].map(a => ({
      id: ((a.getAttribute('href') || '').match(/genre=(\d+)/) || [])[1] || '',
      name: a.textContent.trim(),
    })).filter(s => s.id && s.name),
  })).filter(g => g.name && g.subs.length);
}

function parseLrDetail(html) {
  const doc = toDoc(html);
  const el = doc.querySelector('.blockBook') || doc.body;
  const about = el.querySelector('.blAboutBook');
  const paras = [...el.querySelectorAll('.blTextBook p')]
    .map(p => p.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return {
    id: ((el.querySelector('a[href*="read_book.php"]')?.getAttribute('href') || '').match(/[?&]id=(\d+)/) || [])[1] || '',
    title: el.querySelector('.blNameBook h3, .blNameBook h2')?.textContent.trim() || '',
    author: about?.querySelector('a[href*="biography-author"] strong, a[href*="biography-author"]')?.textContent.trim() || '',
    cover: about?.querySelector('img.book-cover')?.getAttribute('src') || '',
    genres: [...el.querySelectorAll('.blGenres a')].map(a => a.textContent.replace(/[«»]/g, '').trim()).filter(Boolean),
    year: lrField(about, 'Год'),
    pages: lrField(about, 'Страниц'),
    readTime: lrField(about, 'Время чтения'),
    description: paras.join('\n\n'),
  };
}

function parseLrPage(html) {
  const doc = toDoc(html);
  const main = doc.querySelector('#readerContent');
  const blocks = [];
  if (main) {
    // Текущая разметка: <p class=MsoNormal>. Старая (book-paragraph/book-title) оставлена на случай отката.
    main.querySelectorAll('.book-title, .book-paragraph, .MsoNormal').forEach(el => {
      const text = (el.querySelector('.book-title-line') || el).textContent.replace(/\s+/g, ' ').trim();
      if (text) blocks.push({ t: el.classList.contains('book-title') ? 'h' : 'p', x: text });
    });
  }
  const page = Number((doc.querySelector('.number-page-book')?.textContent.match(/(\d+)/) || [])[1]) || 1;
  const nums = [...doc.querySelectorAll('.navigation a')]
    .map(a => Number(((a.getAttribute('href') || '').match(/[?&]p=(\d+)/) || [])[1])).filter(Boolean);
  const head = doc.querySelector('h1')?.textContent.trim() || '';
  return {
    page,
    total: Math.max(page, ...nums, 1),
    blocks,
    title: head.replace(/^Книга\s+/, '').replace(/,\s*страница\s+\d+\s*[–-].*$/i, '').trim(),
    author: (head.match(/страница\s+\d+\s*[–-]\s*(.+)$/i) || [])[1]?.trim() || '',
  };
}

/* ---------- 7. API ---------- */

/* Загрузка с кэшем: свежие данные не запрашиваем повторно, а если источник
   недоступен — отдаём то, что уже сохранили, вместо экрана ошибки. */
async function cached(key, ttl, loader, valid) {
  const hit = store.get(key);
  if (hit) return hit;
  const stale = store.getStale(key);
  try {
    const data = await loader();
    if (!valid || valid(data)) { store.set(key, data, ttl); return data; }
    // Ответ не похож на настоящую страницу (заглушка источника) — берём сохранённую копию.
    return stale || data;
  } catch (e) {
    if (stale) return stale;
    throw e;
  }
}

const apiList = (cat, page = 1) =>
  cached(
    `list:${cat}:${page}`, TTL.list,
    async () => parseListing(await fetchText(`${SRC.list}/${cat}/${page > 1 ? '?page=' + page : ''}`)),
    d => d.items.length
  );

const apiGenres = () =>
  cached(
    'genres', TTL.genres,
    async () => parseGenres(await fetchText(`${SRC.list}/genres/`)),
    d => d.length
  );

const apiGenre = (slug, page = 1) =>
  cached(
    `genre:${slug}:${page}`, TTL.list,
    async () => parseListing(await fetchText(`${SRC.list}/genre/${slug}/${page > 1 ? '?page=' + page : ''}`)),
    d => d.items.length
  );

const apiSearch = (query, page = 1) =>
  cached(
    `search:${query}:${page}`, TTL.search,
    async () => parseListing(await fetchText(`${SRC.list}/search/?q=${encodeURIComponent(query)}${page > 1 ? '&page=' + page : ''}`)),
    d => d.items.length
  );

async function apiBook(slug) {
  const key = 'book:' + slug;
  const hit = store.get(key);
  if (hit) return hit;
  const backup = () => store.getStale(key) || dl.offlineBook(slug);
  try {
    const data = parseBook(await fetchText(`${SRC.book}/book/${slug}/`), { slug });
    if (data.title && data.chapters.length) { store.set(key, data, TTL.book); return data; }
    return backup() || data;
  } catch (e) {
    // Источник недоступен — берём сохранённую копию или скачанную для офлайна книгу.
    const saved = backup();
    if (saved) return saved;
    throw e;
  }
}

const errorText = e => {
  if (navigator.onLine === false) return 'Нет подключения к интернету. Скачанные книги — во вкладке «Офлайн».';
  if (e && e.message === 'limit') return 'Источник ограничивает частоту запросов. Подождите минуту.';
  return 'Не удалось загрузить данные. Проверьте подключение.';
};

/* --- LoveRead: читабельные книги --- */

const apiLrList = (page = 1) => {
  // Свежие поступления отдаются только на главной loveread.ec; пагинации у списка нет.
  if (page > 1) return Promise.resolve([]);
  return cached('lr:list:1', TTL.lr, async () => parseLrList(await fetchText(SRC_READ + '/')), d => d.length);
};

const apiLrGenres = () =>
  cached('lr:genres', TTL.genres, async () => parseLrGenres(await fetchText(SRC_READ + '/')), d => d.length);

const apiLrGenre = (id, page = 1) =>
  cached(
    `lr:genre:${id}:${page}`, TTL.lr,
    async () => parseLrList(await fetchText(`${SRC_READ}/genre.php?genre=${id}${page > 1 ? '&page=' + page : ''}`)),
    d => d.length
  );

const apiLrDetail = (id) =>
  cached('lr:book:' + id, TTL.lrbook, async () => parseLrDetail(await fetchText(`${SRC_READ}/book-comments.php?book=${id}`)), d => d.title);

async function apiLrPage(id, page = 1) {
  const key = `lr:page:${id}:${page}`;
  const hit = store.get(key);
  if (hit) return hit;
  const off = await cacheGetText(DATA_CACHE, `off:lrpage:${id}:${page}`);   // скачано для офлайна
  if (off) {
    const data = parseLrPage(off);
    if (data.blocks.length) { store.set(key, data, TTL.lrpage); return data; }
  }
  try {
    const data = parseLrPage(await fetchText(`${SRC_READ}/read_book.php?id=${id}&p=${page}`));
    if (data.blocks.length) store.set(key, data, TTL.lrpage);
    return data;
  } catch (e) {
    const stale = store.getStale(key);
    if (stale) return stale;
    throw e;
  }
}

/* ---------- 7½. Менеджер загрузок (офлайн) ---------- */

function fmtETA(sec) {
  if (!isFinite(sec) || sec <= 0) return '~1 мин';
  if (sec < 90) return '~1 мин';
  const m = Math.round(sec / 60);
  if (m < 60) return '~' + m + ' мин';
  return '~' + (m / 60).toFixed(1).replace('.0', '') + ' ч';
}

const dlIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v11M12 14l-4.5-4.5M12 14l4.5-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16.5v2A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function dlLabel(meta) {
  if (!meta) return 'Скачать для офлайна';
  if (meta.status === 'done') return 'Скачано · удалить';
  if (meta.status === 'paused') return `Продолжить загрузку (${meta.done}/${meta.total})`;
  return 'Скачивается…';
}

const dl = {
  task: null,   // { id, title, kind, total, done, t0, cancel, fails }

  busy() { return !!this.task; },
  meta(id) { return store.get('dl:' + id) || null; },
  // Книга, сохранённая вместе с загрузкой — из неё собирается вкладка «Офлайн».
  offlineBook(id) { const m = store.getStale('dl:' + id); return (m && m.book) || null; },
  // Все скачанные аудиокниги (для вкладки «Офлайн»).
  offlineList() {
    return Object.keys(localStorage)
      .filter(k => k.startsWith('polka:dl:'))
      .map(k => {
        const id = k.slice('polka:dl:'.length);
        if (id.startsWith('r')) return null;                       // это читалка, не аудио
        const m = store.getStale('dl:' + id);
        if (!m || m.status !== 'done') return null;
        const b = m.book || store.getStale('book:' + id);
        if (!b || !b.title) return null;
        return {
          ...b,
          slug: b.slug || id,
          author: b.author || (b.authors && b.authors[0]) || '',
          reader: b.reader || (b.readers && b.readers[0]) || '',
        };
      })
      .filter(Boolean);
  },

  async audio(book) {
    if (this.busy()) return toast('Уже идёт другая загрузка');
    const total = book.chapters.length;
    const prev = this.meta(book.slug) || {};
    if (prev.status === 'done') return;
    const t = this.task = { id: book.slug, title: book.title, kind: 'audio', total, done: prev.done || 0, t0: Date.now(), cancel: false, fails: 0 };
    this.paint();
    try {
      const c = await caches.open(MEDIA_CACHE);
      for (let i = t.done; i < total; i++) {
        if (t.cancel) break;
        try {
          const res = await fetch(book.chapters[i].url, { mode: 'no-cors' });
          await c.put(book.chapters[i].url, res);
          t.fails = 0;
        } catch { if (++t.fails > 3) throw new Error('quota'); }
        t.done = i + 1;
        this.paint();
      }
      const status = t.cancel ? 'paused' : 'done';
      store.set('dl:' + t.id, { status, total, done: t.done, title: t.title, book }, 365 * 24 * 3600e3);
      toast(status === 'done' ? 'Готово — можно слушать без сети' : 'Загрузка остановлена');
    } catch {
      store.set('dl:' + t.id, { status: 'paused', total, done: t.done, title: t.title, book }, 365 * 24 * 3600e3);
      toast('Загрузка не удалась — возможно, мало места');
    } finally { this.task = null; this.paint(); }
  },

  async reader(id, title) {
    if (this.busy()) return toast('Уже идёт другая загрузка');
    const prev = this.meta('r' + id) || {};
    if (prev.status === 'done') return;
    const t = this.task = { id: 'r' + id, title, kind: 'read', total: prev.total || 1, done: prev.done || 0, t0: Date.now(), cancel: false };
    this.paint();
    try {
      if (!t.total || t.total <= 1 && !t.done) {
        const first = await fetchText(`${SRC_READ}/read_book.php?id=${id}&p=1`);
        await cachePutText(DATA_CACHE, `off:lrpage:${id}:1`, first);
        t.total = parseLrPage(first).total || 1;
        t.done = Math.max(t.done, 1);
        this.paint();
      }
      for (let p = t.done + 1; p <= t.total; p++) {
        if (t.cancel) break;
        const html = await fetchText(`${SRC_READ}/read_book.php?id=${id}&p=${p}`);
        if (!await cachePutText(DATA_CACHE, `off:lrpage:${id}:${p}`, html)) throw new Error('quota');
        t.done = p;
        this.paint();
        await sleep(500);   // бережём лимиты шлюза
      }
      const status = t.cancel ? 'paused' : 'done';
      store.set('dl:' + t.id, { status, total: t.total, done: t.done }, 365 * 24 * 3600e3);
      toast(status === 'done' ? 'Готово — можно читать без сети' : 'Загрузка остановлена');
    } catch {
      store.set('dl:' + t.id, { status: 'paused', total: t.total, done: t.done }, 365 * 24 * 3600e3);
      toast('Загрузка не удалась — возможно, мало места');
    } finally { this.task = null; this.paint(); }
  },

  async remove(id, urls) {
    try {
      const name = id.startsWith('r') ? DATA_CACHE : MEDIA_CACHE;
      const c = await caches.open(name);
      if (urls) await Promise.all(urls.map(u => c.delete(u)));
      else {
        const bookId = id.replace(/^r/, '');
        const keys = await c.keys();
        await Promise.all(keys.map(k => String(k.url).includes('off:lrpage:' + bookId + ':') && c.delete(k)));
      }
    } catch {}
    localStorage.removeItem('polka:dl:' + id);
    toast('Загрузка удалена');
  },

  paint() {
    const card = $('#dl-card');
    if (!card) return;
    const t = this.task;
    if (!t) { card.classList.add('is-hidden'); return; }
    const pct = t.total ? Math.min(100, Math.round(t.done / t.total * 100)) : 0;
    let sub = `${t.done} из ${t.total} · ${pct}%`;
    const el = (Date.now() - t.t0) / 1000;
    const rate = t.done ? t.done / el : 0;
    if (rate > 0 && t.done < t.total) sub += ` · осталось ${fmtETA((t.total - t.done) / rate)}`;
    $('#dl-title').textContent = t.title;
    $('#dl-sub').textContent = sub;
    $('#dl-fill').style.width = pct + '%';
    card.classList.remove('is-hidden');
  },
};

/* ---------- 8. Состояние и роутер ---------- */

const view = $('#view');
const sentinel = $('#sentinel');

const state = {
  route: '',
  cat: 'new',
  back: 'cat/new',   // куда вернуться из поиска
  page: 1,
  items: [],
  loading: false,
  ended: false,
  query: '',
  scroll: {},
  book: null,
  seq: 0,            // токен актуальности рендера списка
  rd: null,          // контекст читалки для стрелок клавиатуры { id, page, total }
};

let observer = null;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/cat/new';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}

function go(hash, { replace = false } = {}) {
  const url = location.pathname + location.search + '#' + hash;
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  route();
}

function saveScroll() {
  if (state.route) state.scroll[state.route] = window.scrollY;
}

function restoreScroll(route) {
  const y = state.scroll[route];
  if (y) requestAnimationFrame(() => window.scrollTo(0, y));
}

function route() {
  saveScroll();
  closeSheet();
  const { parts, q } = parseHash();
  const head = parts[0] || 'cat';
  state.route = head + '/' + (parts[1] || '');
  state.rd = null;
  window.scrollTo(0, 0);
  document.title = 'Полка';
  disconnectObserver();

  const searching = head === 'search';
  const detail = head === 'book' || head === 'rbook' || head === 'rread';
  const reader = head === 'rread';
  const offline = document.body.classList.contains('is-offline');
  const isCat = head === 'cat' || head === 'genres' || head === 'genre';
  // На «Мои книги» и «Библиотеку» режим не переключаем — там и аудио, и тексты.
  if (head !== 'my' && head !== 'lib') applyMode(READ_HEADS.includes(head) ? 'read' : 'listen');
  rdPage(reader);   // тема страницы — только в читалке
  // В читалке не должно быть ничего лишнего: только текст и кнопка настроек.
  document.body.classList.toggle('is-reader', reader);
  $('#topbar').classList.toggle('is-hidden', reader);
  $('#headbar').classList.toggle('is-hidden', detail || reader || offline || !(isCat || searching));
  $('#tabbar').classList.toggle('is-hidden', detail || reader);
  $('#chips').classList.toggle('is-hidden', searching);
  $('#search-bar').classList.toggle('is-hidden', !searching);
  markTab(head, parts[1]);
  markTabbar(head, parts[1], offline);

  if (head === 'cat') return parts[1] === 'offline' ? renderOffline() : renderCatalog(parts[1] || 'new');
  if (head === 'genres') return renderGenres();
  if (head === 'genre') return renderGenre(parts[1], parts[2] || '');
  if (head === 'search') return openSearch(q.get('q') || '');
  if (head === 'book') return renderBook(parts[1]);
  if (head === 'my') return renderMy();
  if (head === 'lib') return renderLib();
  if (head === 'read') return renderReadList();
  if (head === 'rgenres') return renderReadGenres();
  if (head === 'rgenre') return renderReadGenre(parts[1], decodeURIComponent(parts[2] || ''));
  if (head === 'rbook') return renderReadBook(parts[1]);
  if (head === 'rread') return renderReader(parts[1], Number(parts[2]) || 1);
  go('cat/new', { replace: true });
}

const READ_HEADS = ['read', 'rgenres', 'rgenre', 'rbook', 'rread'];

/* Режим библиотеки: 'listen' (аудио) или 'read' (книги для чтения) */
function applyMode(mode) {
  document.body.dataset.mode = mode;
  localStorage.setItem('polka:mode', mode);
}

function markTab(head, param) {
  const mode = document.body.dataset.mode || 'listen';
  $$('.chip-tab').forEach(t => {
    let on = false;
    if (t.dataset.m === mode) {
      const cat = t.dataset.cat;
      on = mode === 'listen'
        ? (cat === 'genres' && (head === 'genres' || head === 'genre'))
          || (head === 'cat' && cat === (param || 'new'))
        : (cat === 'new' && head === 'read')
          || (cat === 'genres' && (head === 'rgenres' || head === 'rgenre'));
    }
    t.classList.toggle('is-active', on);
  });
}

/* Активный пункт нижнего таб-бара. Без интернета активен только «Офлайн». */
function markTabbar(head, param, offline) {
  let key = 'cat';
  if (offline) key = 'offline';
  else if (head === 'my') key = 'my';
  else if (head === 'lib') key = 'lib';
  $$('.tabbar-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tab === key));
}

/* Офлайн-режим: без сети остаётся только «Офлайн» и приложение переходит туда. */
function netUpdate() {
  const off = !navigator.onLine;
  document.body.classList.toggle('is-offline', off);
  const { parts } = parseHash();
  const head = parts[0] || '';
  const main = ['', 'cat', 'genres', 'genre', 'search', 'my', 'lib'].includes(head);
  if (off) {
    if (main) go('cat/offline', { replace: true });
    else route();                       // обновляем таб-бар, не срывая чтение книги
  } else if (head === 'cat' && parts[1] === 'offline') {
    go('cat/new');                      // сеть вернулась — уходим с офлайн-экрана
  } else {
    route();
  }
}

/* ---------- 9. Отрисовка ---------- */

const clockIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M9 7H11V12H16V14H9V7Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12ZM20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12Z" fill="currentColor"/></svg>';
const playIcon = '<svg viewBox="3 2 18 20" fill="none"><path d="M15 12.3301L9 16.6603L9 8L15 12.3301Z" fill="currentColor"/></svg>';

const cardHTML = (b, i) => `
  <a class="card" style="--i:${i}" data-slug="${esc(b.slug)}" href="#/book/${esc(b.slug)}">
    <div class="cover">
      ${b.cover ? `<img src="${esc(coverImg(b.cover))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
      <span class="spine"></span>
      <span class="shine"></span>
      ${b.genre ? `<span class="genre-pill">${esc(b.genre)}</span>` : ''}
      ${b.time ? `<span class="dur-pill">${clockIcon}${esc(b.time)}</span>` : ''}
      <span class="play-fab">${playIcon}</span>
      <span class="eq"><i></i><i></i><i></i></span>
    </div>
    <div class="card-title">${esc(b.title)}</div>
    <div class="card-sub">${esc(b.author || b.reader || '')}</div>
  </a>`;

/* Карточка читабельной книги (LoveRead): тот же вид, но без плеера и длительности. */
const bookIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 7.5v6.2M9 7.5l4.6 2.4L9 12.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const readerCardHTML = (b, i) => `
  <a class="card rcard" style="--i:${i}" data-id="${esc(b.id)}" href="#/rbook/${esc(b.id)}">
    <div class="cover">
      ${b.cover ? `<img src="${esc(lrCover(b.cover))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
      <span class="spine"></span>
      <span class="shine"></span>
      ${b.genre ? `<span class="genre-pill">${esc(b.genre)}</span>` : ''}
      ${b.time ? `<span class="dur-pill">${clockIcon}${esc(b.time)}</span>` : ''}
    </div>
    <div class="card-title">${esc(b.title)}</div>
    <div class="card-sub">${esc(b.author || '')}</div>
  </a>`;

/* Подсветка карточки текущей книги */
function syncPlaying() {
  const slug = (player.book && player.book.slug) || '';
  const on = document.body.classList.contains('playing');
  $$('.card').forEach(c => {
    c.classList.toggle('is-playing', !!on && !!slug && c.dataset.slug === slug);
  });
}

const skeletonHTML = (n = 8) => `
  <div class="grid">${Array.from({ length: n }, () => `
    <div class="card" style="--i:0">
      <div class="cover sk" style="animation:none"></div>
      <div class="sk" style="height:13px;width:88%"></div>
      <div class="sk" style="height:11px;width:56%"></div>
    </div>`).join('')}
  </div>`;

const stateHTML = (title, text, action) => `
  <div class="state"><b>${esc(title)}</b>${esc(text || '')}
    ${action ? `<button id="state-action">${esc(action.label)}</button>` : ''}
  </div>`;

function spinner() { $('#tail').innerHTML = '<div class="spinner"></div>'; }
function clearTail() { $('#tail').innerHTML = ''; }

/* Карточки «Продолжить»: последняя аудиокнига и книги, которые читали */
function continueListenHTML() {
  const last = store.get('last');
  if (!last || !last.chapters || !last.chapters.length) return '';
  const ch = last.chapters[Math.min(last.index || 0, last.chapters.length - 1)] || {};
  const total = Number(ch.duration) || 0;
  const pct = total ? Math.min(100, Math.round((Number(last.position) || 0) / total * 100)) : 0;
  return `<div class="section-title">Продолжить слушать</div>
    <button class="cont-card cont-listen" id="cont-listen">
      ${last.cover ? `<img src="${esc(coverImg(last.cover))}" alt="" referrerpolicy="no-referrer">` : ''}
      <span class="cont-meta"><span class="cont-title">${esc(last.title)}</span>
      <span class="cont-sub">${esc(ch.title || '')}</span></span>
      <span class="cont-bar"><i style="width:${pct}%"></i></span>
    </button>`;
}

function continueReadHTML(title = 'Продолжить чтение', limit = 4) {
  const items = startedReadItems(limit);
  if (!items.length) return '';
  return `<div class="section-title">${esc(title)}</div>
    <div class="cont-grid">${items.map(v => {
      const pct = v.t ? Math.min(100, Math.round(v.p / v.t * 100)) : 0;
      return `<button class="cont-card" data-id="${esc(v.id)}" data-p="${v.p}">
        <span class="cont-title">${esc(v.title)}</span>
        <span class="cont-sub">стр. ${v.p} из ${v.t || '—'} · ${pct}%</span>
        <span class="cont-bar"><i style="width:${pct}%"></i></span>
      </button>`;
    }).join('')}</div>`;
}

/* Начатые книги для чтения — свежие сверху. */
function startedReadItems(limit = 4) {
  return Object.keys(localStorage)
    .filter(k => k.startsWith('polka:lr:pos:'))
    .map(k => { try { const r = JSON.parse(localStorage.getItem(k)); return { id: k.slice('polka:lr:pos:'.length), e: r.e, ...r.d }; } catch { return null; } })
    .filter(v => v && v.title && v.p > 1)
    .sort((a, b) => b.e - a.e)
    .slice(0, limit);
}

function bindContinueRead() {
  $$('.cont-card[data-id]').forEach(el => el.onclick = () => {
    const id = el.dataset.id;
    const pos = store.get('lr:pos:' + id) || {};
    if (pos.y > 0 && pos.p === Number(el.dataset.p)) pendingScroll = { id, y: pos.y };
    go(`rread/${id}/${Number(el.dataset.p) || 1}`);
  });
}

/* ---------- 10. Каталог ---------- */

async function renderCatalog(cat) {
  const seq = ++state.seq;
  state.cat = cat;
  state.back = 'cat/' + cat;
  state.items = [];
  state.page = 1;
  state.ended = false;
  state.loading = false;
  view.innerHTML = skeletonHTML();
  clearTail();
  try {
    const { items } = await apiList(cat, 1);
    if (seq !== state.seq) return;
    if (!items.length) { view.innerHTML = stateHTML('Пусто', 'Каталог не вернул книг.'); return; }
    state.items = items;
    view.innerHTML = `${continueListenHTML()}<div class="grid">${items.map(cardHTML).join('')}</div>`;
    const cl = $('#cont-listen');
    if (cl) cl.onclick = () => {
      if (player.book) return openSheet();
      if (loadLast({ autoplay: true })) openSheet();   // плеер был закрыт — поднимаем книгу снова
    };
    syncPlaying();
    state.ended = items.length < 10;
    restoreScroll(state.route);
    if (!state.ended) observeMore(() => loadMore('list', cat));
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => renderCatalog(cat);
  }
}

/* ---------- 10.5 Слушать офлайн ---------- */
/* Показываем только книги, целиком скачанные для прослушивания без интернета. */

const trashIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 7h12M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7m-6 0 .8 12.1A1.9 1.9 0 0 0 10.7 21h2.6a1.9 1.9 0 0 0 1.9-1.9L16 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* Сетка скачанных аудиокниг с кнопкой удаления на каждой. */
function offlineGridHTML(list) {
  return `<div class="grid">${list.map((b, i) => `
    <div class="ocard">
      ${cardHTML(b, i)}
      <button class="ocard-del" data-del="${esc(b.slug)}" aria-label="Удалить из офлайна" title="Удалить из офлайна">${trashIcon}</button>
    </div>`).join('')}</div>`;
}

function bindOfflineDel(list, refresh) {
  $$('.ocard-del').forEach(btn => btn.onclick = async e => {
    e.preventDefault(); e.stopPropagation();
    const slug = btn.dataset.del;
    const book = list.find(x => x.slug === slug);
    if (!confirm(`Удалить «${(book && book.title) || slug}» из офлайна?`)) return;
    const saved = dl.offlineBook(slug) || book;
    const urls = saved && saved.chapters ? saved.chapters.map(c => c.url) : null;
    if (player.book && player.book.slug === slug) player.close();
    await dl.remove(slug, urls);
    refresh();
  });
}

function renderOffline() {
  ++state.seq;                 // отменяем незавершённые загрузки предыдущего экрана
  state.cat = 'offline';
  state.back = 'cat/offline';
  state.items = [];
  state.ended = true;          // вкладка без пагинации
  state.loading = false;
  clearTail();
  const list = dl.offlineList();
  if (!list.length) {
    view.innerHTML = stateHTML(
      'Пока пусто',
      'Откройте аудиокнигу и нажмите «Скачать для офлайна» — она появится здесь и будет доступна без интернета.'
    );
    return;
  }
  view.innerHTML = `<div class="section-title">Слушать офлайн</div>${offlineGridHTML(list)}`;
  bindOfflineDel(list, renderOffline);
  syncPlaying();
}

/* ---------- 10.6 Мои книги и Библиотека ---------- */

function bindContinueListen() {
  const cl = $('#cont-listen');
  if (cl) cl.onclick = () => {
    if (player.book) return openSheet();
    if (loadLast({ autoplay: true })) openSheet();   // плеер был закрыт — поднимаем книгу снова
  };
}

/* «Мои книги» — то, что сейчас слушаю и читаю. */
function renderMy() {
  ++state.seq;
  state.cat = 'my';
  state.back = 'my';
  state.items = [];
  state.ended = true;
  state.loading = false;
  clearTail();
  const listen = continueListenHTML();
  const read = continueReadHTML();
  if (!listen && !read) {
    view.innerHTML = stateHTML('Пока пусто', 'Начните слушать аудиокнигу или читать книгу — они появятся здесь.');
    return;
  }
  view.innerHTML = listen + read;
  bindContinueListen();
  bindContinueRead();
  syncPlaying();
}

/* «Библиотека» — только моё: скачанное и начатое. */
function renderLib() {
  ++state.seq;
  state.cat = 'lib';
  state.back = 'lib';
  state.items = [];
  state.ended = true;
  state.loading = false;
  clearTail();
  const list = dl.offlineList();
  const read = continueReadHTML('Начатое', 8);
  if (!list.length && !read) {
    view.innerHTML = stateHTML('Библиотека пуста', 'Скачанные для офлайна и начатые книги появятся здесь.');
    return;
  }
  view.innerHTML = (list.length ? `<div class="section-title">Скачано · ${list.length}</div>${offlineGridHTML(list)}` : '') + read;
  bindOfflineDel(list, renderLib);
  bindContinueRead();
  syncPlaying();
}

/* ---------- 11. Жанры ---------- */

const arrowIcon = '<svg class="arrow" viewBox="0 0 24 24" fill="none"><path d="M10.5858 6.34317L12 4.92896L19.0711 12L12 19.0711L10.5858 17.6569L16.2427 12L10.5858 6.34317Z" fill="currentColor"/></svg>';

async function renderGenres() {
  const seq = ++state.seq;
  view.innerHTML = `<div class="genre-grid">${'<div class="genre-row sk" style="height:52px;animation:none"></div>'.repeat(8)}</div>`;
  try {
    const genres = await apiGenres();
    if (seq !== state.seq) return;
    view.innerHTML = `<div class="genre-grid">${genres.map(g => `
      <a class="genre-row" href="#/genre/${esc(g.slug)}">
        <span class="genre-name">${esc(g.name)}</span>
        <span class="genre-count">${esc(g.count)}</span>
        ${arrowIcon}
      </a>`).join('')}</div>`;
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => renderGenres();
  }
}

async function renderGenre(slug, name) {
  if (!slug) return go('genres');
  const seq = ++state.seq;
  state.cat = 'genre';
  state.back = 'genres';
  state.items = [];
  state.page = 1;
  state.ended = false;
  state.loading = false;
  view.innerHTML = `<div class="back-btn" id="back">${backIcon}Жанры</div>
    <div class="section-title">${esc(name || slug)}</div>${skeletonHTML()}`;
  $('#back').onclick = () => go('genres');
  try {
    const { items } = await apiGenre(slug, 1);
    if (seq !== state.seq) return;
    if (!items.length) { view.innerHTML = stateHTML('Пусто', 'В этом жанре пока нет книг.'); return; }
    state.items = items;
    view.innerHTML = `<div class="back-btn" id="back">${backIcon}Жанры</div>
      <div class="section-title">${esc(name || slug)}</div>
      <div class="grid">${items.map(cardHTML).join('')}</div>`;
    $('#back').onclick = () => go('genres');
    syncPlaying();
    state.ended = items.length < 10;
    restoreScroll(state.route);
    if (!state.ended) observeMore(() => loadMore('genre', slug));
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => renderGenre(slug, name);
  }
}

/* ---------- 12. Поиск ---------- */

const backIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M16.2426 6.34317L14.8284 4.92896L7.75739 12L14.8285 19.0711L16.2427 17.6569L10.5858 12L16.2426 6.34317Z" fill="currentColor"/></svg>';

/* Кнопка очистки видна, только когда в поле есть текст */
function syncClear() {
  const inp = $('#search-input'), btn = $('#search-clear');
  if (inp && btn) btn.classList.toggle('is-hidden', !inp.value.trim());
}

async function openSearch(q) {
  const input = $('#search-input');
  if (document.activeElement !== input) input.value = q || '';
  syncClear();
  if (q) {
    state.query = q;
    runSearch(q);
  } else if (document.activeElement !== input) {
    input.focus();
    view.innerHTML = stateHTML('Поиск', 'Введите название книги, автора или чтеца.');
  }
}

async function runSearch(q) {
  q = (q || '').trim();
  const seq = ++state.seq;
  state.items = [];
  state.page = 1;
  state.ended = false;
  state.loading = false;
  clearTail();
  if (q.length < 2) {
    view.innerHTML = stateHTML('Поиск', 'Введите хотя бы 2 символа.');
    return;
  }
  view.innerHTML = skeletonHTML(6);
  try {
    const { items, total } = await apiSearch(q, 1);
    if (seq !== state.seq) return;
    if (!items.length) { view.innerHTML = stateHTML('Ничего не найдено', 'По запросу «' + q + '» книг нет.'); return; }
    state.items = items;
    view.innerHTML = `<div class="section-title">${total ? 'Найдено: ' + total : 'Результаты'}</div>
      <div class="grid">${items.map(cardHTML).join('')}</div>`;
    syncPlaying();
    state.ended = items.length < 10;
    if (!state.ended) observeMore(() => loadMore('search', q));
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => runSearch(q);
  }
}

/* ---------- 13. Догрузка ---------- */

function disconnectObserver() {
  if (observer) { observer.disconnect(); observer = null; }
}

function observeMore(loader) {
  disconnectObserver();
  observer = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) loader();
  }, { rootMargin: '700px 0px' });
  observer.observe(sentinel);
}

async function loadMore(kind, arg) {
  if (state.loading || state.ended) return;
  const seq = state.seq;
  state.loading = true;
  spinner();
  try {
    const next = state.page + 1;
    const isLr = kind === 'lrlist' || kind === 'lrgenre';
    const items = kind === 'genre' ? (await apiGenre(arg, next)).items
      : kind === 'search' ? (await apiSearch(arg, next)).items
        : kind === 'lrlist' ? await apiLrList(next)
          : kind === 'lrgenre' ? await apiLrGenre(arg, next)
            : (await apiList(arg, next)).items;
    if (seq !== state.seq) return;          // маршрут сменился — результат неактуален
    state.page = next;
    const known = new Set(state.items.map(b => b.id));
    const fresh = items.filter(b => !known.has(b.id));
    if (!items.length || (!isLr && items.length < 10)) state.ended = true;
    if (!fresh.length) { state.ended = true; return; }   // защита от зацикливания догрузки

    state.items.push(...fresh);
    const card = isLr ? readerCardHTML : cardHTML;
    const grid = view.querySelector('.grid');
    if (grid) grid.insertAdjacentHTML('beforeend', fresh.map((b, i) => card(b, i)).join(''));
    syncPlaying();
  } catch (e) {
    if (seq === state.seq) toast(errorText(e));
  } finally {
    if (seq === state.seq) { state.loading = false; clearTail(); }
  }
}

/* ---------- 14. Страница книги ---------- */

const chapterRow = (c, i, current) => `
  <button class="chap ${current === i ? 'is-current' : ''}" data-i="${i}">
    <span class="chap-num">${i + 1}</span>
    <span class="chap-name">${esc(c.title)}</span>
    ${c.duration ? `<span class="chap-time">${fmtTime(c.duration)}</span>` : ''}
  </button>`;

async function renderBook(slug) {
  if (!slug) return go('cat/new');
  const seq = ++state.seq;
  state.loading = false;
  view.innerHTML = skeletonHTML(2);
  try {
    const b = await apiBook(slug);
    if (seq !== state.seq) return;
    state.book = b;
    const playing = player.book && player.book.slug === b.slug;
    view.innerHTML = `
      <div class="back-btn" id="back">${backIcon}Назад</div>
      <div class="book-head">
        <div class="cover">${b.cover ? `<img src="${esc(coverImg(b.cover, 'full'))}" alt="" decoding="async" referrerpolicy="no-referrer">` : ''}</div>
        <div class="book-head-info">
          <div class="book-h1">${esc(b.title)}</div>
          ${b.authors.length ? `<div class="book-line">Автор: <b>${esc(b.authors.join(', '))}</b></div>` : ''}
          ${b.readers.length ? `<div class="book-line">Читает: <b>${esc(b.readers.join(', '))}</b></div>` : ''}
          <div class="chips">
            ${b.genre ? `<span class="chip">${esc(b.genre)}</span>` : ''}
            ${b.duration ? `<span class="chip">${esc(b.duration)}</span>` : ''}
            ${b.rating ? `<span class="chip chip-accent">${esc(b.rating)} ★${b.ratingCount ? ' · ' + esc(b.ratingCount) : ''}</span>` : ''}
            ${b.chapters.length ? `<span class="chip">Глав: ${b.chapters.length}</span>` : ''}
          </div>
        </div>
      </div>
      ${b.chapters.length ? `<button class="play-cta" id="play-cta">
        <svg viewBox="3 2 18 20" fill="none"><path d="M15 12.3301L9 16.6603L9 8L15 12.3301Z" fill="currentColor"/></svg>
        ${playing ? 'Продолжить' : 'Слушать'}</button>
      <button class="dl-cta" id="dl-cta">${dlIcon}${dlLabel(dl.meta(b.slug))}</button>` : ''}
      ${b.description ? `<div class="section-title">Описание</div><div class="book-desc">${esc(b.description)}</div>` : ''}
      ${b.chapters.length > 1 ? `<div class="section-title">Главы</div>
        <div class="sheet-chapters">${b.chapters.map((c, i) => chapterRow(c, i, playing ? player.index : -1)).join('')}</div>` : ''}`;

    $('#back').onclick = () => history.length > 1 ? history.back() : go('cat/new');
    const cta = $('#play-cta');
    if (cta) cta.onclick = () => {
      if (player.book && player.book.slug === b.slug) return audio.paused ? player.toggle() : openSheet();
      player.load(b, 0, true);
      openSheet();
    };
    const dlBtn = $('#dl-cta');
    if (dlBtn) dlBtn.onclick = async () => {
      const m = dl.meta(b.slug);
      if (m && m.status === 'done') {
        await dl.remove(b.slug, b.chapters.map(c => c.url));
        renderBook(b.slug);
      } else {
        dlBtn.disabled = true;
        await dl.audio(b);
        if (state.route === 'book/' + b.slug) renderBook(b.slug);
      }
    };
    view.querySelectorAll('.chap').forEach(btn => {
      btn.onclick = () => {
        const i = Number(btn.dataset.i);
        if (player.book && player.book.slug === b.slug && i === player.index) return openSheet();
        player.load(b, i, true);
        openSheet();
      };
    });
  } catch (e) {
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => renderBook(slug);
  }
}

/* ---------- 15. Читабельные книги (LoveRead) ---------- */

async function renderReadList() {
  const seq = ++state.seq;
  state.cat = 'read';
  state.back = 'read';
  state.items = [];
  state.page = 1;
  state.ended = false;
  state.loading = false;
  const tools = `<div class="read-tools"><button class="ghost-btn" id="to-genres">Жанры</button>
    <span class="read-hint">Читать онлайн</span></div>`;
  const bind = () => { const g = $('#to-genres'); if (g) g.onclick = () => go('rgenres'); };
  view.innerHTML = tools + skeletonHTML();
  bind();
  try {
    const items = await apiLrList(1);
    if (seq !== state.seq) return;
    if (!items.length) { view.innerHTML = stateHTML('Пусто', 'Источник не вернул книг.'); return; }
    state.items = items;
    view.innerHTML = `<div class="read-tools"><button class="ghost-btn" id="to-genres">Жанры</button>
        <span class="read-hint">Свежие поступления</span></div>
      ${continueReadHTML()}
      <div class="grid">${items.map(readerCardHTML).join('')}</div>`;
    bind();
    bindContinueRead();
    state.ended = true;                  // у списка свежих поступлений нет пагинации
    restoreScroll(state.route);
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#state-action').onclick = () => renderReadList();
  }
}

async function renderReadGenres() {
  const seq = ++state.seq;
  const back = `<div class="back-btn" id="back">${backIcon}Читать</div>`;
  view.innerHTML = back + `<div class="section-title">Жанры</div>${'<div class="genre-row sk" style="height:52px;animation:none"></div>'.repeat(6)}`;
  $('#back').onclick = () => go('read');
  try {
    const groups = await apiLrGenres();
    if (seq !== state.seq) return;
    if (!groups.length) { view.innerHTML = back + stateHTML('Пусто', 'Не удалось получить жанры.'); $('#back').onclick = () => go('read'); return; }
    view.innerHTML = back + `<div class="section-title">Жанры</div>
      <div class="lr-groups">${groups.map(g => `
        <div class="lr-group">
          <div class="lr-group-name">${esc(g.name)}</div>
          <div class="lr-chips">${g.subs.map(s => `<a class="chip" href="#/rgenre/${esc(s.id)}/${encodeURIComponent(s.name)}">${esc(s.name)}</a>`).join('')}</div>
        </div>`).join('')}</div>`;
    $('#back').onclick = () => go('read');
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = back + stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#back').onclick = () => go('read');
    $('#state-action').onclick = () => renderReadGenres();
  }
}

async function renderReadGenre(id, name) {
  if (!id) return go('rgenres');
  const seq = ++state.seq;
  state.cat = 'rgenre';
  state.back = 'rgenres';
  state.items = [];
  state.page = 1;
  state.ended = false;
  state.loading = false;
  const head = `<div class="back-btn" id="back">${backIcon}Жанры</div><div class="section-title">${esc(name || 'Жанр')}</div>`;
  view.innerHTML = head + skeletonHTML();
  $('#back').onclick = () => go('rgenres');
  try {
    const items = await apiLrGenre(id, 1);
    if (seq !== state.seq) return;
    if (!items.length) { view.innerHTML = head + stateHTML('Пусто', 'В этом жанре нет книг.'); $('#back').onclick = () => go('rgenres'); return; }
    state.items = items;
    view.innerHTML = head + `<div class="grid">${items.map(readerCardHTML).join('')}</div>`;
    $('#back').onclick = () => go('rgenres');
    state.ended = !items.length;
    restoreScroll(state.route);
    if (!state.ended) observeMore(() => loadMore('lrgenre', id));
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = head + stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#back').onclick = () => go('rgenres');
    $('#state-action').onclick = () => renderReadGenre(id, name);
  }
}

async function renderReadBook(id) {
  if (!id) return go('read');
  const seq = ++state.seq;
  state.loading = false;
  view.innerHTML = skeletonHTML(2);
  const back = `<div class="back-btn" id="back">${backIcon}Назад</div>`;
  try {
    const b = await apiLrDetail(id);
    if (seq !== state.seq) return;
    if (!b.title) { view.innerHTML = stateHTML('Не найдено', 'Книга недоступна.'); return; }
    const pos = store.get('lr:pos:' + id);
    const page = pos && pos.p > 1 ? pos.p : 1;
    view.innerHTML = `${back}
      <div class="book-head">
        <div class="cover">${b.cover ? `<img src="${esc(lrCover(b.cover))}" alt="" decoding="async" referrerpolicy="no-referrer">` : ''}</div>
        <div class="book-head-info">
          <div class="book-h1">${esc(b.title)}</div>
          ${b.author ? `<div class="book-line">Автор: <b>${esc(b.author)}</b></div>` : ''}
          <div class="chips">
            ${b.genres.slice(0, 2).map(g => `<span class="chip">${esc(g)}</span>`).join('')}
            ${b.year ? `<span class="chip">${esc(b.year)}</span>` : ''}
            ${b.pages ? `<span class="chip">${esc(b.pages)}</span>` : ''}
            ${b.readTime ? `<span class="chip chip-accent">${esc(b.readTime)}</span>` : ''}
          </div>
        </div>
      </div>
      <button class="play-cta" id="read-cta">${bookIcon}${page > 1 ? `Продолжить — стр. ${page}${pos && pos.t ? ' из ' + pos.t : ''}` : 'Читать онлайн'}</button>
      <button class="dl-cta" id="dl-cta">${dlIcon}${dlLabel(dl.meta('r' + id))}</button>
      ${b.description ? `<div class="section-title">Описание</div><div class="book-desc">${esc(b.description)}</div>` : ''}`;
    $('#back').onclick = () => history.length > 1 ? history.back() : go('read');
    $('#read-cta').onclick = () => {
      if (pos && pos.y > 0) pendingScroll = { id, y: pos.y };
      go(`rread/${id}/${page}`);
    };
    const dlBtn = $('#dl-cta');
    if (dlBtn) dlBtn.onclick = async () => {
      const m = dl.meta('r' + id);
      if (m && m.status === 'done') {
        await dl.remove('r' + id, null);
        renderReadBook(id);
      } else {
        dlBtn.disabled = true;
        await dl.reader(id, b.title);
        if (state.route === 'rbook/' + id) renderReadBook(id);
      }
    };
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = back + stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#back').onclick = () => go('read');
    $('#state-action').onclick = () => renderReadBook(id);
  }
}

/* ---------- Настройки чтения (сохраняются) ---------- */

const RD_W = { narrow: 54, medium: 66, wide: 80 };
const RD_DEF = { scale: 1, lh: 1.7, width: 'medium', font: 'sans', theme: 'auto' };

const rdSet = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('polka:rd')) || {}; } catch {}
  const out = { ...RD_DEF, ...saved };
  const legacy = Number(localStorage.getItem('polka:rdscale'));   // переносим старый размер шрифта
  if (!saved.scale && legacy) out.scale = Math.min(1.6, Math.max(0.8, legacy));
  // интервал приводим к шагу ползунка (1.4 … 2.2 с шагом 0.05)
  out.lh = Math.min(2.2, Math.max(1.4, Math.round(Number(out.lh) / 0.05) * 0.05));
  return out;
})();

const rdSave = () => { try { localStorage.setItem('polka:rd', JSON.stringify(rdSet)); } catch {} };

function rdApply() {
  const st = document.documentElement.style;
  st.setProperty('--rd', rdSet.scale);
  st.setProperty('--rd-lh', rdSet.lh);
  st.setProperty('--rd-w', (RD_W[rdSet.width] || RD_W.medium) + 'ch');
  $$('.reader').forEach(r => r.classList.toggle('rd-serif', rdSet.font === 'serif'));
}

/* Тема страницы включается только на экране чтения */
function rdPage(on) {
  if (on && rdSet.theme !== 'auto') document.body.dataset.rdPage = rdSet.theme;
  else delete document.body.dataset.rdPage;
}

/* При смене размера текст перетекает — держим абзац на месте, чтобы не терять строку. */
function rdKeepPlace(mutate) {
  const ps = $$('.reader .rd-p, .reader .rd-chap');
  const mid = window.scrollY + innerHeight * 0.35;
  let idx = -1;
  ps.forEach((p, i) => { if (p.offsetTop <= mid) idx = i; });
  const before = idx >= 0 ? ps[idx].offsetTop - window.scrollY : null;
  mutate();
  if (before === null) return;
  const after = ps[idx].offsetTop - window.scrollY;
  if (after !== before) window.scrollBy(0, after - before);
}

/* Закладки и прыжок к сохранённой позиции */
let pendingScroll = null;

function readerExcerpt() {
  const mid = window.scrollY + innerHeight * 0.4;
  let cur = null;
  for (const p of $$('.rd-p')) { if (p.offsetTop <= mid) cur = p; else break; }
  return cur ? cur.textContent.trim().slice(0, 90) : '';
}

const bmIcon = '<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4.2L6 21V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';

const bmAll = id => store.get('bm:' + id) || [];
function bmSave(id, list) { store.set('bm:' + id, list, 365 * 24 * 3600e3); }

function renderBm(id, page) {
  const box = $('#bm-list');
  if (!box) return;
  const list = bmAll(id);
  $('#bm-count').textContent = list.length ? String(list.length) : '';
  $('#rd-bm').classList.toggle('is-on', list.some(bm => bm.page === page));
  box.classList.toggle('is-empty', !list.length);
  box.innerHTML = list.map((bm, i) => `
    <button class="bm-item" data-i="${i}">
      <span class="bm-page">стр. ${bm.page}</span>
      <span class="bm-ex">${esc(bm.excerpt)}</span>
    </button>`).join('');
  box.querySelectorAll('.bm-item').forEach(btn => btn.onclick = () => {
    const bm = list[Number(btn.dataset.i)];
    if (bm.page === page) window.scrollTo({ top: bm.y, behavior: 'smooth' });
    else { pendingScroll = { id, y: bm.y }; go(`rread/${id}/${bm.page}`); }
  });
}

/* Заметки к страницам книги */
const nmAll = id => store.get('nm:' + id) || [];
function nmSave(id, list) { store.set('nm:' + id, list, 365 * 24 * 3600e3); }

function renderNm(id, page) {
  const box = $('#nm-list');
  if (!box) return;
  const list = nmAll(id);
  const cnt = $('#nm-count');
  if (cnt) cnt.textContent = list.length ? String(list.length) : '';
  const cur = list.find(n => n.page === page);
  const ta = $('#nm-text');
  if (ta && document.activeElement !== ta) ta.value = (cur && cur.text) || '';
  box.classList.toggle('is-empty', !list.length);
  box.innerHTML = list.map((n, i) => `
    <button class="bm-item nm-item${n.page === page ? ' is-cur' : ''}" data-i="${i}">
      <span class="bm-page">стр. ${n.page}</span>
      <span class="bm-ex">${esc(n.text)}</span>
    </button>`).join('');
  box.querySelectorAll('.nm-item').forEach(btn => btn.onclick = () => {
    const n = list[Number(btn.dataset.i)];
    if (n.page === page) { const t = $('#nm-text'); if (t) t.focus(); }
    else go(`rread/${id}/${n.page}`);
  });
}

/* Панель настроек чтения */
let rdPanelOpen = false;

const rdCloseIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';

function rdPanelHTML() {
  const seg = (name, items) => `<div class="rd-seg" data-seg="${name}">${
    items.map(([v, label]) => `<button data-v="${v}" class="${rdSet[name] === v ? 'on' : ''}">${label}</button>`).join('')
  }</div>`;
  const pct = Math.round(rdSet.scale * 100);
  return `<div class="rd-panel is-hidden" id="rd-panel">
    <div class="rd-panel-head">
      <span class="rd-panel-title">Читалка</span>
      <span class="rd-count" id="rd-page"></span>
      <button class="rd-close" id="rd-panel-close" aria-label="Закрыть">${rdCloseIcon}</button>
    </div>
    <div class="rd-row">
      <span class="rd-row-name">Размер</span>
      <input type="range" id="rd-scale" min="80" max="160" step="5" value="${pct}" aria-label="Размер текста">
      <span class="rd-val" id="rd-scale-val">${pct}%</span>
    </div>
    <div class="rd-row">
      <span class="rd-row-name">Интервал</span>
      <input type="range" id="rd-lh" min="1.4" max="2.2" step="0.05" value="${rdSet.lh}" aria-label="Межстрочный интервал">
      <span class="rd-val" id="rd-lh-val">${rdSet.lh.toFixed(2)}</span>
    </div>
    <div class="rd-row rd-row-col">
      <span class="rd-row-name">Ширина колонки</span>
      ${seg('width', [['narrow', 'Узкая'], ['medium', 'Средняя'], ['wide', 'Широкая']])}
    </div>
    <div class="rd-row rd-row-col">
      <span class="rd-row-name">Шрифт</span>
      ${seg('font', [['sans', 'Без засечек'], ['serif', 'С засечками']])}
    </div>
    <div class="rd-row rd-row-col">
      <span class="rd-row-name">Тема страницы</span>
      ${seg('theme', [['auto', 'Авто'], ['sepia', 'Сепия'], ['light', 'Светлая'], ['dark', 'Тёмная']])}
    </div>
    <div class="rd-sec">
      <div class="rd-sec-head">
        <span class="rd-sec-name">Закладки</span>
        <button class="rd-mini" id="rd-bm">${bmIcon}<span>Добавить</span><span id="bm-count"></span></button>
      </div>
      <div class="bm-list is-empty" id="bm-list"></div>
    </div>
    <div class="rd-sec">
      <div class="rd-sec-head">
        <span class="rd-sec-name">Заметки</span>
        <span class="rd-sec-num" id="nm-count"></span>
      </div>
      <textarea class="nm-text" id="nm-text" rows="3" placeholder="Заметка к этой странице"></textarea>
      <button class="rd-save" id="nm-save">Сохранить заметку</button>
      <div class="bm-list is-empty" id="nm-list"></div>
    </div>
    <button class="rd-exit" id="rd-exit">Закрыть книгу</button>
  </div>`;
}

function openRdPanel(on) {
  rdPanelOpen = on;
  const panel = $('#rd-panel');
  if (panel) panel.classList.toggle('is-hidden', !on);
  const btn = $('#rd-aa');
  if (btn) btn.classList.toggle('is-on', !!on);
}

function wireRdPanel(id) {
  $('#rd-aa').onclick = () => openRdPanel(!rdPanelOpen);
  $('#rd-panel-close').onclick = () => openRdPanel(false);
  $('#rd-scale').oninput = e => {
    rdSet.scale = Number(e.target.value) / 100;
    $('#rd-scale-val').textContent = e.target.value + '%';
    rdKeepPlace(rdApply);
    rdSave();
  };
  $('#rd-lh').oninput = e => {
    rdSet.lh = Number(e.target.value);
    $('#rd-lh-val').textContent = rdSet.lh.toFixed(2);
    rdKeepPlace(rdApply);
    rdSave();
  };
  $$('#rd-panel [data-seg]').forEach(box => {
    box.querySelectorAll('button').forEach(btn => btn.onclick = () => {
      rdSet[box.dataset.seg] = btn.dataset.v;
      box.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === btn));
      if (box.dataset.seg === 'theme') rdPage(true);
      rdKeepPlace(rdApply);
      rdSave();
    });
  });
  // Закладка на текущем месте страницы
  $('#rd-bm').onclick = () => {
    const page = rdView.page;
    const list = bmAll(id);
    const at = list.findIndex(bm => bm.page === page && Math.abs(bm.y - window.scrollY) < 200);
    if (at >= 0) { list.splice(at, 1); toast('Закладка удалена'); }
    else {
      list.push({ page, y: window.scrollY, excerpt: readerExcerpt(), ts: Date.now() });
      list.sort((a, b) => a.page - b.page || a.y - b.y);
      toast('Закладка добавлена');
    }
    bmSave(id, list);
    renderBm(id, page);
  };
  // Заметка к странице
  $('#nm-save').onclick = () => {
    const page = rdView.page;
    const text = ($('#nm-text').value || '').trim();
    const list = nmAll(id).filter(n => n.page !== page);
    if (text) { list.push({ page, text, ts: Date.now() }); list.sort((a, b) => a.page - b.page); toast('Заметка сохранена'); }
    else toast('Заметка удалена');
    nmSave(id, list);
    renderNm(id, page);
  };
  $('#rd-exit').onclick = () => go('rbook/' + id);
  openRdPanel(rdPanelOpen);
}

/* ---------- Листание читалки: без перерисовки всего экрана ---------- */

const RD_ANIM = 240;                                             // мс — совпадает с переходом ниже
const RD_EASE = `transform ${RD_ANIM / 1000}s cubic-bezier(.22,.61,.36,1)`;

const rdView = { id: null, page: 1, total: 1, busy: false, cache: new Map() };

const rdKey = (id, p) => id + ':' + p;

async function rdLoad(id, page) {
  const k = rdKey(id, page);
  if (rdView.cache.has(k)) return rdView.cache.get(k);
  const d = await apiLrPage(id, page);
  rdView.cache.set(k, d);
  return d;
}

/* Соседние страницы подтягиваем заранее — тогда свайп стартует мгновенно */
function rdPrefetch() {
  [1, -1].forEach(dir => {
    const p = rdView.page + dir;
    if (p >= 1 && p <= rdView.total) rdLoad(rdView.id, p).catch(() => {});
  });
}

const rdBodyHTML = d => d.blocks.map(b => b.t === 'h'
  ? `<h3 class="rd-chap">${esc(b.x)}</h3>`
  : `<p class="rd-p">${esc(b.x)}</p>`).join('') || '<p class="rd-p">Страница пуста.</p>';

const rdPct = (page, total) => total ? Math.min(100, Math.round(page / total * 100)) : 0;

/* Меняем всё, кроме текста: счётчик, прогресс, кнопки, закладки, адрес */
function rdSync(page) {
  rdView.page = page;
  state.rd = { id: rdView.id, page, total: rdView.total };
  store.set('lr:pos:' + rdView.id, { p: page, t: rdView.total, title: rdView.title, y: 0 }, 365 * 24 * 3600e3);
  const cnt = $('#rd-page');
  if (cnt) cnt.textContent = page + ' / ' + rdView.total;
  const bar = $('#rd-pct');
  if (bar) bar.style.width = rdPct(page, rdView.total) + '%';
  renderBm(rdView.id, page);
  renderNm(rdView.id, page);
  history.replaceState({}, '', location.pathname + location.search + `#/rread/${rdView.id}/${page}`);
}

/* Страницы доезжают до края, затем содержимое меняется местами */
function rdSettle(cur, ghost, w, dir, target) {
  rdView.busy = true;
  cur.style.transition = RD_EASE;
  ghost.style.transition = RD_EASE;
  cur.style.transform = `translateX(${-dir * w}px)`;
  ghost.style.transform = 'translateX(0)';
  window.scrollTo(0, 0);
  setTimeout(() => {
    cur.innerHTML = ghost.innerHTML;
    cur.style.transition = ''; cur.style.transform = '';
    ghost.remove();
    rdView.busy = false;
    rdSync(target);
    rdPrefetch();
  }, RD_ANIM);
}

/* Перелистывание кнопками и стрелками — та же анимация, что и у свайпа */
async function rdSlideTo(target, dir) {
  if (rdView.busy || !rdView.id || target < 1 || target > rdView.total) return;
  const stage = $('#rd-stage'), cur = $('#rd-cur');
  if (!stage || !cur) return;
  rdView.busy = true;
  let d;
  try { d = await rdLoad(rdView.id, target); }
  catch { rdView.busy = false; toast('Страница не загрузилась'); return; }
  const w = stage.clientWidth || 1;
  const ghost = document.createElement('article');
  ghost.className = 'reader rd-page rd-ghost';
  ghost.innerHTML = rdBodyHTML(d);
  ghost.style.transition = 'none';
  ghost.style.transform = `translateX(${dir > 0 ? w : -w}px)`;
  stage.appendChild(ghost);
  cur.style.transition = 'none';
  cur.style.transform = 'translateX(0)';
  void ghost.offsetWidth;                     // фиксируем стартовое положение до анимации
  rdSettle(cur, ghost, w, dir, target);
}

/* Свайп: страница едет за пальцем, соседняя выезжает навстречу */
const sw = { on: false, drag: false, pid: 0, x0: 0, y0: 0, dx: 0, t0: 0, dir: 1, cur: null, ghost: null, w: 1, ready: false };

function bindRdSwipe() {
  const stage = $('#rd-stage');
  if (!stage) return;
  sw.on = false; sw.drag = false; sw.cur = sw.ghost = null;

  stage.addEventListener('pointerdown', e => {
    if (rdView.busy || rdView.total < 2) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sw.on = true; sw.drag = false; sw.pid = e.pointerId;
    sw.x0 = e.clientX; sw.y0 = e.clientY; sw.dx = 0;
  });

  stage.addEventListener('pointermove', e => {
    if (!sw.on || e.pointerId !== sw.pid) return;
    const dx = e.clientX - sw.x0, dy = e.clientY - sw.y0;

    if (!sw.drag) {
      if (Math.abs(dx) < 12) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.2) { sw.on = false; return; }   // жест вертикальный — это скролл
      const dir = dx < 0 ? 1 : -1;
      const target = rdView.page + dir;
      if (target < 1 || target > rdView.total) { sw.on = false; return; }
      const cached = rdView.cache.get(rdKey(rdView.id, target));
      sw.dir = dir; sw.drag = true; sw.t0 = Date.now(); sw.ready = !!cached;
      sw.cur = $('#rd-cur'); sw.w = stage.clientWidth || 1;
      const ghost = document.createElement('article');
      ghost.className = 'reader rd-page rd-ghost';
      ghost.innerHTML = cached ? rdBodyHTML(cached) : '';
      ghost.style.transition = 'none';
      ghost.style.transform = `translateX(${dir > 0 ? sw.w : -sw.w}px)`;
      stage.appendChild(ghost);
      sw.ghost = ghost;
      sw.cur.style.transition = 'none';
      if (!cached) {
        rdLoad(rdView.id, target)
          .then(d => { sw.ready = true; ghost.innerHTML = rdBodyHTML(d); })
          .catch(() => {});
      }
      try { stage.setPointerCapture(e.pointerId); } catch {}
    }

    if (!sw.drag) return;
    e.preventDefault();
    const lim = sw.w;
    let pull = e.clientX - sw.x0;
    if (Math.abs(pull) > lim) pull = Math.sign(pull) * (lim + (Math.abs(pull) - lim) * 0.35);   // за краем — с сопротивлением
    sw.dx = pull;
    sw.cur.style.transform = `translateX(${pull}px)`;
    sw.ghost.style.transform = `translateX(${(sw.dir > 0 ? lim : -lim) + pull}px)`;
  });

  const end = e => {
    if (!sw.on || e.pointerId !== sw.pid) return;
    sw.on = false;
    if (!sw.drag) return;
    sw.drag = false;
    const cur = sw.cur, ghost = sw.ghost, w = sw.w, dir = sw.dir;
    sw.cur = sw.ghost = null;
    const flick = Date.now() - sw.t0 < 350 && Math.abs(sw.dx) > 36;
    if (sw.ready && (flick || Math.abs(sw.dx) > w * 0.25)) {
      rdSettle(cur, ghost, w, dir, rdView.page + dir);
    } else {                                   // не дотянули — возвращаем на место
      cur.style.transition = RD_EASE;
      ghost.style.transition = RD_EASE;
      cur.style.transform = 'translateX(0)';
      ghost.style.transform = `translateX(${dir > 0 ? w : -w}px)`;
      setTimeout(() => { ghost.remove(); cur.style.transition = ''; cur.style.transform = ''; }, RD_ANIM);
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

async function renderReader(id, page) {
  if (!id) return go('read');
  const seq = ++state.seq;
  state.loading = false;
  const back = `<div class="back-btn" id="back">${backIcon}Назад</div>`;
  view.innerHTML = back + skeletonHTML(1);
  $('#back').onclick = () => go('rbook/' + id);
  try {
    const d = await apiLrPage(id, page);
    if (seq !== state.seq) return;
    store.set('lr:pos:' + id, { p: d.page, t: d.total, title: d.title, y: 0 }, 365 * 24 * 3600e3);
    state.rd = { id, page: d.page, total: d.total };
    const body = d.blocks.map(b => b.t === 'h'
      ? `<h3 class="rd-chap">${esc(b.x)}</h3>`
      : `<p class="rd-p">${esc(b.x)}</p>`).join('');
    const pct = d.total ? Math.min(100, Math.round(d.page / d.total * 100)) : 0;
    // В книге — только текст, тонкая полоса прогресса и одна кнопка настроек.
    view.innerHTML = `
      <div class="rd-topline"><i id="rd-pct" style="width:${pct}%"></i></div>
      <button class="rd-fab" id="rd-aa" aria-label="Настройки чтения" title="Настройки чтения">Aa</button>
      ${rdPanelHTML()}
      <div class="rd-stage" id="rd-stage"><article class="reader rd-page" id="rd-cur">${body || '<p class="rd-p">Страница пуста.</p>'}</article></div>`;
    if (d.title) document.title = d.title + ' — Полка';
    rdApply();
    rdPage(true);
    renderBm(id, d.page);
    renderNm(id, d.page);
    wireRdPanel(id);
    // Контекст листания: кэш страниц живёт, пока открыта та же книга
    if (rdView.id !== id) { rdView.cache.clear(); rdView.id = id; }
    rdView.page = d.page; rdView.total = d.total; rdView.title = d.title; rdView.busy = false;
    rdSync(d.page);
    bindRdSwipe();
    rdPrefetch();
    if (pendingScroll && pendingScroll.id == id) {
      const y = pendingScroll.y;
      pendingScroll = null;
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
  } catch (e) {
    if (seq !== state.seq) return;
    view.innerHTML = back + stateHTML('Ошибка', errorText(e), { label: 'Повторить' });
    $('#back').onclick = () => go('rbook/' + id);
    $('#state-action').onclick = () => renderReader(id, page);
  }
}

/* ---------- 16. Плеер ---------- */

const audio = $('#audio');
let savedTick = 0;

const player = {
  book: null,
  index: 0,
  sheet: false,

  get chapters() { return (this.book && this.book.chapters) || []; },
  get current() { return this.chapters[this.index] || null; },

  load(book, index = 0, autoplay = false) {
    this.book = book;
    this.index = Math.min(Math.max(0, index), Math.max(0, book.chapters.length - 1));
    const ch = this.current;
    if (!ch) return;
    audio.src = ch.url;
    audio.currentTime = 0;
    this.paint();
    if (autoplay) audio.play().catch(() => toast('Нажмите ещё раз, чтобы начать воспроизведение'));
  },

  play(i) {
    if (!this.book) return;
    if (typeof i === 'number' && i !== this.index) return this.load(this.book, i, true);
    audio.play().catch(() => {});
  },

  toggle() { audio.paused ? this.play() : audio.pause(); },

  next(auto = false) {
    if (this.index >= this.chapters.length - 1) {
      if (auto) { audio.pause(); toast('Книга закончилась'); }
      return;
    }
    this.load(this.book, this.index + 1, true);
  },

  prev() {
    if (audio.currentTime > 4) { audio.currentTime = 0; return; }
    if (this.index > 0) this.load(this.book, this.index - 1, true);
  },

  seek(sec) { audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + sec)); },

  /* Закрыть аудиокнигу: останавливаем воспроизведение и убираем плеер.
     Позиция сохраняется — книгу можно продолжить с карточки «Продолжить слушать». */
  close() {
    if (!this.book) return;
    this.persist();
    const last = store.get('last');
    if (last) store.set('last', { ...last, closed: true }, 365 * 24 * 3600e3);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    this.book = null;
    this.index = 0;
    this.sheet = false;
    $('#sheet').classList.add('is-hidden');
    document.body.classList.remove('sheet-open', 'playing');
    $('#mini').classList.add('is-hidden');
    syncPlaying();
  },

  paint() {
    const b = this.book, ch = this.current;
    if (!b || !ch) return;
    const sub = ch.title;
    $('#mini-cover').src = coverImg(b.cover) || '';
    $('#mini-title').textContent = b.title;
    $('#mini-sub').textContent = sub;
    $('#sheet-cover').src = coverImg(b.cover, 'full') || '';
    $('#sheet-title').textContent = b.title;
    $('#sheet-sub').textContent = sub;
    $('#sheet-amb').style.backgroundImage = b.cover ? `url("${coverImg(b.cover)}")` : 'none';
    $('#mini').classList.remove('is-hidden');

    const box = $('#sheet-chapters');
    if (b.chapters.length > 1) {
      box.innerHTML = b.chapters.map((c, i) => chapterRow(c, i, this.index)).join('');
      box.querySelectorAll('.chap').forEach(btn => {
        btn.onclick = () => this.load(b, Number(btn.dataset.i), true);
      });
      const cur = box.querySelector('.chap.is-current');
      if (cur) box.scrollTop = Math.max(0, cur.offsetTop - box.clientHeight / 2 + cur.clientHeight / 2);
    } else {
      box.innerHTML = '';
    }

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: ch.title,
          artist: b.readers.join(', ') || b.authors.join(', '),
          album: b.title,
          artwork: b.cover ? [{ src: coverImg(b.cover, 'full'), sizes: '512x512', type: 'image/jpeg' }] : [],
        });
      } catch {}
    }
    document.title = b.title + ' — Полка';
    this.persist();
    syncPlaying();
  },

  persist() {
    if (!this.book) return;
    store.set('last', {
      slug: this.book.slug,
      title: this.book.title,
      cover: this.book.cover,
      readers: this.book.readers,
      chapters: this.book.chapters,
      index: this.index,
      position: audio.currentTime || 0,
    }, 365 * 24 * 3600e3);
  },
};

/* Поднимаем последнюю книгу из сохранения. autoplay — для карточки «Продолжить слушать». */
function loadLast({ autoplay = false } = {}) {
  const last = store.get('last');
  if (!last || !last.chapters || !last.chapters.length) return false;
  player.book = { slug: last.slug, title: last.title, cover: last.cover, readers: last.readers || [], authors: [], chapters: last.chapters };
  player.index = Math.min(Math.max(0, last.index || 0), last.chapters.length - 1);
  audio.src = player.current.url;
  if (last.position > 5) audio.addEventListener('loadedmetadata', () => { audio.currentTime = last.position; }, { once: true });
  player.paint();
  document.body.classList.remove('playing');
  if (autoplay) audio.play().catch(() => {});
  return true;
}

function restoreLast() {
  const last = store.get('last');
  if (!last || last.closed) return;   // плеер закрыт вручную — не показываем
  loadLast();
}

/* --- события аудио --- */

audio.addEventListener('play', () => { document.body.classList.add('playing'); syncPlaying(); });
audio.addEventListener('pause', () => { document.body.classList.remove('playing'); syncPlaying(); });

audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0;
  const pct = d ? (audio.currentTime / d) * 100 : 0;
  $('#mini-bar').style.width = pct + '%';
  if (!sheetDragging) {
    $('#sheet-seek').value = d ? Math.round((audio.currentTime / d) * 1000) : 0;
    $('#sheet-seek').style.setProperty('--p', pct + '%');
    $('#sheet-cur').textContent = fmtTime(audio.currentTime);
    $('#sheet-dur').textContent = fmtTime(d);
  }
  if (Date.now() - savedTick > 5000) { savedTick = Date.now(); player.persist(); }
});

audio.addEventListener('ended', () => player.next(true));

audio.addEventListener('error', async () => {
  // ссылка могла протухнуть — перезапрашиваем страницу книги
  const b = player.book;
  if (!b || !b.slug || audio.dataset.retried === b.slug) return;
  audio.dataset.retried = b.slug;
  try {
    store.drop('book:' + b.slug);
    const fresh = await apiBook(b.slug);
    if (!fresh.chapters.length) return;
    const keep = audio.currentTime;
    player.book = fresh;
    audio.src = fresh.chapters[player.index].url;
    if (keep > 1) audio.currentTime = keep;
    if (document.body.classList.contains('playing')) audio.play().catch(() => {});
  } catch {}
});

let sheetDragging = false;
$('#sheet-seek').addEventListener('input', () => {
  sheetDragging = true;
  const d = audio.duration || 0;
  const pct = Number($('#sheet-seek').value) / 10;
  $('#sheet-seek').style.setProperty('--p', pct + '%');
  $('#sheet-cur').textContent = fmtTime(d * $('#sheet-seek').value / 1000);
});
$('#sheet-seek').addEventListener('change', () => {
  const d = audio.duration || 0;
  if (d) audio.currentTime = d * $('#sheet-seek').value / 1000;
  sheetDragging = false;
});

/* --- управление --- */

$('#mini-play').onclick = e => { e.stopPropagation(); player.toggle(); };
$('#mini-close').onclick = e => { e.stopPropagation(); player.close(); };
$('#mini-open').onclick = () => openSheet();
$('#ctrl-play').onclick = () => player.toggle();
$('#ctrl-prev').onclick = () => player.prev();
$('#ctrl-next').onclick = () => player.next();
$('#ctrl-back').onclick = () => player.seek(-15);
$('#ctrl-fwd').onclick = () => player.seek(30);

function openSheet() {
  if (!player.book) return;
  player.sheet = true;
  $('#sheet').classList.remove('is-hidden');
  document.body.classList.add('sheet-open');
}
function closeSheet() {
  if (!player.sheet) return;
  player.sheet = false;
  $('#sheet').classList.add('is-hidden');
  document.body.classList.remove('sheet-open');
}
$('#sheet-grab').onclick = closeSheet;
$('#sheet-close').onclick = closeSheet;
$('#sheet-bg').onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => player.toggle());
  navigator.mediaSession.setActionHandler('pause', () => player.toggle());
  navigator.mediaSession.setActionHandler('nexttrack', () => player.next());
  navigator.mediaSession.setActionHandler('previoustrack', () => player.prev());
  navigator.mediaSession.setActionHandler('seekbackward', () => player.seek(-15));
  navigator.mediaSession.setActionHandler('seekforward', () => player.seek(30));
}

/* ---------- 17. Тема ---------- */

function applyTheme(mode) {
  const theme = mode || localStorage.getItem('polka:theme')
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('polka:theme', theme);
  $('meta[name="theme-color"]').setAttribute('content', theme === 'light' ? '#f7f7f8' : '#000000');
}

/* ---------- 18. Инициализация ---------- */

function bindUI() {
  $('#btn-theme').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  };
  $('#btn-search').onclick = () => {
    if (parseHash().parts[0] === 'search') return $('#search-input').focus();
    go('search');
  };
  const input = $('#search-input');
  const clearBtn = $('#search-clear');
  const runSearchDebounced = debounce(() => runSearch(input.value), 500);

  $('#search-cancel').onclick = () => {
    input.value = '';
    syncClear();
    input.blur();
    go(state.back || 'cat/new');
  };
  clearBtn.onclick = () => {
    input.value = '';
    syncClear();
    input.focus();
    runSearch('');
  };

  input.addEventListener('input', () => { syncClear(); runSearchDebounced(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      input.blur();
      const q = input.value.trim();
      if (q) go('search?q=' + encodeURIComponent(q));
    }
  });

  $('#btn-mode').onclick = () => {
    const next = document.body.dataset.mode === 'read' ? 'listen' : 'read';
    applyMode(next);
    go(next === 'read' ? 'read' : 'cat/new');
  };

  $('#chips').addEventListener('click', e => {
    const tab = e.target.closest('.chip-tab');
    if (!tab || tab.dataset.m !== (document.body.dataset.mode || 'listen')) return;
    const cat = tab.dataset.cat;
    if (tab.dataset.m === 'read') go(cat === 'genres' ? 'rgenres' : 'read');
    else go(cat === 'genres' ? 'genres' : 'cat/' + cat);
  });

  $('#tabbar').addEventListener('click', e => {
    const btn = e.target.closest('.tabbar-btn');
    if (!btn) return;
    const t = btn.dataset.tab;
    if (t === 'cat') go((document.body.dataset.mode || 'listen') === 'read' ? 'read' : 'cat/new');
    else if (t === 'my') go('my');
    else if (t === 'lib') go('lib');
    else if (t === 'offline') go('cat/offline');
  });

  // Стрелки ←/→ — листание страниц в читалке
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && rdPanelOpen) { openRdPanel(false); return; }
    const rd = state.rd;
    if (!rd || e.altKey || e.metaKey || e.ctrlKey) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight' && rd.page < rd.total) rdSlideTo(rd.page + 1, 1);
    else if (e.key === 'ArrowLeft' && rd.page > 1) rdSlideTo(rd.page - 1, -1);
  });

  const toTop = $('#to-top');
  toTop.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  // Офлайн-режим реагирует на пропажу и возвращение сети
  window.addEventListener('online', netUpdate);
  window.addEventListener('offline', netUpdate);
  $('#dl-cancel').onclick = () => {
    if (dl.task) { dl.task.cancel = true; $('#dl-sub').textContent = 'Останавливаю…'; }
  };
  let posTick = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    toTop.hidden = y < 900;
    saveScroll();
    // позиция чтения — сохраняем с лёгким троттлингом
    if (state.rd && Date.now() - posTick > 1500) {
      posTick = Date.now();
      const pos = store.get('lr:pos:' + state.rd.id);
      if (pos && pos.p === state.rd.page) store.set('lr:pos:' + state.rd.id, { ...pos, y: window.scrollY }, 365 * 24 * 3600e3);
    }
  }, { passive: true });
}

function boot() {
  applyTheme();
  rdApply();
  // загрузки, прерванные закрытием страницы, помечаем как паузу — их можно продолжить
  Object.keys(localStorage).filter(k => k.startsWith('polka:dl:')).forEach(k => {
    try {
      const r = JSON.parse(localStorage.getItem(k));
      if (r.d && r.d.status === 'active') { r.d.status = 'paused'; localStorage.setItem(k, JSON.stringify(r)); }
    } catch {}
  });
  bindUI();
  restoreLast();
  window.addEventListener('hashchange', route);
  const startOffline = !navigator.onLine;
  document.body.classList.toggle('is-offline', startOffline);
  if (!location.hash) go(startOffline ? 'cat/offline' : (localStorage.getItem('polka:mode') === 'read' ? 'read' : 'cat/new'), { replace: true });
  else route();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
