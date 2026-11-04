const $ = s => document.querySelector(s), view = $('#view'), rd = $('#reader');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} if (['shelf', 'prog', 'bm', 'set', 'books', 'st', 'sd', 'bs', 'qt'].includes(k)) queueSync(); }
};
let BOOKS = store.get('books', {}), shelf = store.get('shelf', []), prog = store.get('prog', {}), bm = store.get('bm', {}), sd = store.get('sd', {}), bs = store.get('bs', {}), qt = store.get('qt', {});
let set = { mode: 'page', fs: 19, ff: 'serif', th: 'light', lh: 1.6, rate: 1, ...store.get('set', {}) };
let ST = store.get('st', {}); ST.id ||= 'd' + Math.random().toString(36).slice(2, 8); ST.dev ||= {};
const FONTS = { serif: 'Georgia,"Noto Serif","Times New Roman",serif', sans: 'system-ui,-apple-system,Roboto,sans-serif' };
const THEME_COLOR = { light: '#ffffff', sepia: '#f4ecd8', gray: '#3b3b3f', dark: '#000000' };

const bid = b => (b.downloads?.[0]?.link.match(/\/b\/(\d+)/) || [])[1];
const reg = list => list.filter(b => { const id = bid(b); if (id) { b.id = id; BOOKS[id] = b; } return id; });
function saveBooks() {
  const keep = keepIds();
  store.set('books', Object.fromEntries([...keep].filter(i => BOOKS[i]).map(i => [i, BOOKS[i]])));
}
async function api(p) {
  const r = await fetch(p), d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Ошибка сервера ' + r.status);
  return d;
}
const authorOf = b => (b.author || []).map(a => a.name).join(', ');
const descParts = (h = '') => h.split(/<br\s*\/?>/i).map(p => new DOMParser().parseFromString(p, 'text/html').body.textContent.trim()).filter(Boolean);

/* ---------- SVG-иконки (в стиле Lucide, inline — работают офлайн) ---------- */
const IC = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  mark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  sync: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  skipf: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
  skipb: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',
  sliders: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>'
};
Object.assign(IC, {
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'
});
const ic = (n, sz = 22, fill) => `<svg class="ic" width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;
const errBox = m => `<div class="msg err">${ic('alert', 20)}<span>${esc(m)}</span></div>`;
$('#tabbar').innerHTML = [['home', '#/', 'home', 'Главная'], ['search', '#/search', 'search', 'Поиск'], ['lib', '#/lib', 'library', 'Библиотека'], ['me', '#/me', 'user', 'Профиль']]
  .map(([t, h, i, n]) => `<a href="${h}" data-t="${t}">${ic(i, 24)}${n}</a>`).join('');

/* ---------- уведомления ---------- */
function snack(m) {
  document.querySelector('.snack')?.remove();
  const t = document.createElement('div'); t.className = 'snack'; t.textContent = m; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

/* ---------- статусы книг: хочу прочитать / читаю / прочитано ---------- */
// явный статус (bs) главнее; для старых данных статус выводится из прогресса и полки
const statusOf = id => {
  const x = bs[id]; if (x) return x.s === 'none' ? '' : x.s;
  if (prog[id]) return prog[id].p > .97 ? 'done' : 'read';
  return shelf.includes(id) ? 'want' : '';
};
const allIds = () => new Set([...shelf, ...Object.keys(prog), ...Object.keys(bs).filter(i => bs[i].s !== 'none')]);
function setStatus(id, s) {
  bs[id] = { s: s || 'none', ts: Date.now() };
  if (s === 'want') { if (!shelf.includes(id)) shelf = [id, ...shelf]; } else shelf = shelf.filter(i => i !== id);
  store.set('bs', bs); store.set('shelf', shelf); saveBooks();
}
const STATUS_MSG = { want: 'Добавлено в «Хочу прочитать»', read: 'Перенесено в «Читаю»', done: 'Отмечено как прочитанное', none: 'Убрано из библиотеки' };
function statusSheet(id, after) {
  const b = BOOKS[id]; if (!b) return;
  const bg = document.createElement('div'), sh = document.createElement('div'); bg.className = 'sheetbg'; sh.className = 'sheet';
  document.body.append(bg, sh);
  const close = () => { bg.remove(); sh.remove(); }, cur = statusOf(id);
  const opts = [['want', 'Хочу прочитать', 'mark'], ['read', 'Читаю сейчас', 'play'], ['done', 'Прочитано', 'check']];
  sh.innerHTML = `<div class="sh-h"><h3>${esc(b.title)}</h3><button class="chip" data-x="1" aria-label="Закрыть">${ic('x', 16)}</button></div>
    <div class="sopts">${opts.map(([k, t, i]) => `<button class="sopt${cur === k ? ' on' : ''}" data-s="${k}">${ic(i, 20)}<span>${t}</span>${cur === k ? ic('check', 18) : ''}</button>`).join('')}
    ${cur ? `<button class="sopt dng" data-s="none">${ic('trash', 20)}<span>Убрать из библиотеки</span></button>` : ''}</div>`;
  bg.onclick = close;
  sh.onclick = e => {
    const x = e.target.closest('[data-s],[data-x]'); if (!x) return;
    if (x.dataset.x) return close();
    const k = x.dataset.s; setStatus(id, k === 'none' ? '' : k); snack(STATUS_MSG[k]); close(); after && after();
  };
}

/* ---------- офлайн-хранилище текстов книг (IndexedDB) ---------- */
const OFF = new Map(); // id -> { pin, ts }: pin = скачано вручную, иначе автосохранено при чтении
const idb = () => idb.p ||= new Promise((res, rej) => {
  const r = indexedDB.open('bookapp', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('texts', { keyPath: 'id' }); r.result.createObjectStore('meta', { keyPath: 'id' }); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const idbRun = async (stores, mode, fn) => {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode); let out;
    try { out = fn(...stores.map(n => t.objectStore(n))); } catch (e) { return rej(e); }
    t.oncomplete = () => res(out && 'result' in out ? out.result : out); t.onerror = t.onabort = () => rej(t.error);
  });
};
const offGet = id => idbRun(['texts'], 'readonly', s => s.get(id)).then(r => r?.paras || null).catch(() => null);
async function offPut(id, paras, pin) {
  try {
    const keep = !!(pin || OFF.get(id)?.pin), ts = Date.now();
    await idbRun(['texts', 'meta'], 'readwrite', (s, m) => { s.put({ id, paras }); m.put({ id, pin: keep, ts }); });
    OFF.set(id, { pin: keep, ts });
    // автосохранённые книги храним только 20 последних, скачанные вручную не трогаем
    [...OFF.entries()].filter(([, v]) => !v.pin).sort((a, b) => b[1].ts - a[1].ts).slice(20).forEach(([k]) => offDel(k));
  } catch {}
}
const offDel = id => { OFF.delete(id); return idbRun(['texts', 'meta'], 'readwrite', (s, m) => { s.delete(id); m.delete(id); }).catch(() => {}); };
async function offLoad() { try { (await idbRun(['meta'], 'readonly', m => m.getAll()) || []).forEach(r => OFF.set(r.id, { pin: r.pin, ts: r.ts })); } catch {} }
offLoad();
async function toggleOffline(id, btn) {
  if (OFF.has(id)) { await offDel(id); snack('Удалено из памяти устройства'); return book(id); }
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Скачиваем…';
  try {
    const d = await apiLoad('/api/read?id=' + id, null);
    await offPut(id, d.paras, true);
    if (!OFF.has(id)) throw new Error('не хватило места на устройстве');
    snack('Книга сохранена — её можно читать без интернета');
  } catch (e) { snack('Не получилось скачать: ' + e.message); }
  if (location.hash === '#/book/' + id) book(id);
}

/* ---------- поделиться цитатой ---------- */
async function shareQuote(q, id) {
  const b = BOOKS[id] || {}, au = authorOf(b);
  const t = `«${q.x}»` + (q.n ? `\n\n${q.n}` : '') + `\n\n— ${au ? au + ', ' : ''}«${b.title || ''}»`;
  try { if (navigator.share) { await navigator.share({ text: t }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(t); snack('Цитата скопирована'); } catch { snack('Не удалось поделиться'); }
}

/* ---------- загрузка с реальным временем ожидания ---------- */
const lat = store.get('lat', {});
const fmtT = sec => sec < 60 ? Math.max(1, Math.ceil(sec)) + ' с' : Math.floor(sec / 60) + ' мин ' + Math.round(sec % 60) + ' с';
const SK = {
  rows: n => Array.from({ length: n }, () => '<div class="skrow"><div class="sk c"></div><div class="tx"><div class="sk l1"></div><div class="sk l2"></div><div class="sk l3"></div></div></div>').join(''),
  text: () => '<div class="sktext">' + [92, 100, 96, 100, 64, 0, 100, 94, 100, 86, 100, 58].map(w => w ? `<div class="sk" style="width:${w}%"></div>` : '<div style="height:16px"></div>').join('') + '</div>'
};
async function apiLoad(path, box, label = 'Загрузка') {
  const key = path.split('?')[0], typ = lat[key], t0 = performance.now(), ok = box && box.isConnected;
  // вместо счётчика секунд показываем «скелет» будущего содержимого (на полках он уже нарисован в home())
  if (ok && !box.classList.contains('rail')) box.innerHTML = box.id === 'lbox' ? SK.text() : SK.rows(box.id === 'res' ? 6 : 3);
  const slow = setTimeout(() => { if (box && box.isConnected && !box.classList.contains('rail')) box.insertAdjacentHTML('beforeend', '<div class="slow">Сервер отвечает медленно, ещё немного…</div>'); }, 8000);
  try {
    // до трёх попыток: сбой библиотеки обычно проходит со второго раза
    let r, d, err;
    for (let n = 0; n < 3; n++) {
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), n ? 20000 : 30000);
      try {
        r = await fetch(path, { signal: ac.signal }); d = await r.json().catch(() => ({}));
        if (r.ok || (r.status < 500 && r.status !== 429)) { err = null; break; }
        err = new Error('Библиотека пока не отвечает — обновите через минуту');
      } catch (e) { err = new Error(e.name === 'AbortError' ? 'Библиотека отвечает слишком медленно — обновите через минуту' : 'Нет связи с сервером'); }
      finally { clearTimeout(to); }
      if (n < 2) await new Promise(res => setTimeout(res, 1200 * (n + 1)));
    }
    if (err) throw err;
    if (!r.ok) throw new Error(d.error || 'Ошибка сервера ' + r.status);
    const dt = (performance.now() - t0) / 1000; lat[key] = typ ? typ * .6 + dt * .4 : dt; store.set('lat', lat);
    return d;
  } finally { clearTimeout(slow); }
}

const hue = s => [...String(s)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 360;

function cover(b, eager) {
  const h = hue(b.id), g = `linear-gradient(160deg,hsl(${h},60%,48%),hsl(${(h + 40) % 360},55%,32%))`;
  // есть обложка: показываем нейтральную подложку и плавно проявляем картинку; цветная карточка только если обложки нет или она не загрузилась
  const img = b.cover ? `<img ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" src="/api/img?p=${encodeURIComponent(b.cover)}" alt="" onload="this.classList.add('ok')" onerror="this.parentNode.classList.add('nocv');this.remove()">` : '';
  return `<div class="cv${b.cover ? ' hc' : ''}" style="--g:${g}"><span>${esc(b.title)}</span>${img}</div>`;
}
const railItem = (b, i = 99) => `<a class="it" href="#/book/${b.id}">${cover(b, i < 5)}<b>${esc(b.title)}</b><small>${esc(authorOf(b))}</small>${
  prog[b.id] ? `<div class="bar"><i style="width:${Math.round(prog[b.id].p * 100)}%"></i></div>` : ''}</a>`;
const rowItem = (b, i = 99) => `<a class="row" href="#/book/${b.id}">${cover(b, i < 8)}<div><b>${esc(b.title)}</b><small>${esc(authorOf(b))}</small><small>${esc((b.categories || []).slice(0, 2).join(', '))}</small>${prog[b.id] ? `<div class="bar"><i style="width:${Math.round(prog[b.id].p * 100)}%"></i></div>` : ''}</div></a>`;

const rowLib = b => `<div class="rw">${rowItem(b)}<button class="rdel" data-st="${b.id}" aria-label="Статус книги">${ic('more', 20)}</button></div>`;

/* ---------- роутер ---------- */
// своя «история» переходов: history.back() в Telegram иногда ничего не делает, а так «назад» работает всегда
const NAVS = [location.hash || '#/'];
addEventListener('hashchange', () => {
  const h = location.hash || '#/', n = NAVS.length;
  if (n > 1 && NAVS[n - 2] === h) NAVS.pop(); else if (NAVS[n - 1] !== h) NAVS.push(h);
});
function goBack(fallback = '#/') {
  if (NAVS.length > 1) { NAVS.pop(); location.hash = NAVS[NAVS.length - 1]; return; }
  const h = location.hash || '#/'; if (h !== fallback && h !== '#/' && h !== '#') location.hash = fallback;
}
function route() {
  const [, page, arg] = location.hash.split('/');
  document.querySelectorAll('#tabbar a').forEach(a => a.classList.toggle('on', a.dataset.t === (page || 'home') || (page === 'book' && a.dataset.t === 'home') || (page === 'genre' && a.dataset.t === 'search')));
  if (page === 'read') { openReader(arg); return; }
  closeReader();
  ({ '': home, search, lib, book, me, genre }[page ?? ''] || home)(arg);
  if (page !== 'book') window.scrollTo(0, 0);
  view.classList.remove('vin'); void view.offsetWidth; view.classList.add('vin'); // мягкое появление экрана
}
window.addEventListener('hashchange', route);

/* ---------- главная ---------- */
const SHELVES = [['Классика детектива', 'Шерлок Холмс'], ['Космос и будущее', 'Дюна'], ['Магия и приключения', 'Гарри Поттер'],
  ['Русская классика', 'Война и мир'], ['Антиутопии', '1984'], ['Загадки и мистика', 'Мастер и Маргарита']];
function home() {
  const reading = byStatus('read'), want = byStatus('want');
  view.innerHTML = `<h1>Книги</h1><div class="free">Все книги полностью бесплатны — без подписки и регистрации</div><div class="chips">${GENRES.map(g => `<a class="chip" href="#/genre/${g[0]}">${esc(g[1])}</a>`).join('')}</div>` +
    (reading.length ? `<div class="sec"><h2>Продолжить чтение</h2><div class="rail">${reading.map(railItem).join('')}</div></div>` : '') +
    (want.length ? `<div class="sec"><h2>Хочу прочитать</h2><div class="rail">${want.map(railItem).join('')}</div></div>` : '') +
    SHELVES.map(([t], i) => `<div class="sec"><h2>${t}</h2><div class="rail" id="sh${i}">${'<div class="sk-it"><div class="skel"></div><div class="tx"><div class="sk l1"></div><div class="sk l2"></div></div></div>'.repeat(5)}</div></div>`).join('');
  SHELVES.forEach(async ([, q], i) => {
    try {
      const d = await apiLoad(`/api/books?q=${encodeURIComponent(q)}&limit=10`, $('#sh' + i), 'Загрузка полки');
      const el = $('#sh' + i); if (el) el.innerHTML = reg(d.items).map(railItem).join('') || '<div class="msg">Пусто</div>';
    } catch (e) { const el = $('#sh' + i); if (el) el.innerHTML = `${errBox(e.message)}`; }
  });
}

/* ---------- поиск и жанры ---------- */
let S = { q: '', mode: 'books', page: 0, items: [], authors: [], authorId: null, more: false };
const GENRES = [
  ['detective', 'Детектив', ['Шерлок Холмс', 'Убийство', 'Расследование', 'Тайна']],
  ['scifi', 'Фантастика', ['Дюна', 'Космос', 'Звёздные', 'Робот']],
  ['fantasy', 'Фэнтези', ['Гарри Поттер', 'Властелин колец', 'Дракон', 'Волшебник']],
  ['classic', 'Классика', ['Война и мир', 'Преступление и наказание', 'Анна Каренина', 'Мастер и Маргарита']],
  ['dystopia', 'Антиутопия', ['1984', '451 градус по Фаренгейту', 'О дивный новый мир', 'Мы']],
  ['horror', 'Ужасы', ['Ужас', 'Вампир', 'Дракула', 'Кошмар']],
  ['love', 'Романы', ['Любовь', 'Гордость и предубеждение', 'Джейн Эйр', 'Сердце']],
  ['adventure', 'Приключения', ['Остров сокровищ', 'Робинзон Крузо', 'Путешествие', 'Капитан']],
  ['history', 'История', ['История', 'Империя', 'Война', 'Древний мир']],
  ['kids', 'Детям', ['Сказки', 'Приключения Тома Сойера', 'Незнайка', 'Буратино']],
  ['humor', 'Юмор', ['Юмор', 'Двенадцать стульев', 'Весёлые', 'Ирония']],
  ['science', 'Наука', ['Наука', 'Физика', 'Психология', 'Мозг']]
];
const genreGrid = () => `<h2>Жанры</h2><div class="gg">${GENRES.map(([k, t]) => `<a class="gt" href="#/genre/${k}" style="--h:${hue(k)}">${esc(t)}</a>`).join('')}</div>`;
function search() {
  view.innerHTML = `<h1>Поиск</h1><form class="sbox" id="sf"><input id="sq" type="search" placeholder="Книга или автор" value="${esc(S.q)}" enterkeyhint="search"></form>
  <div class="chips"><button class="chip ${S.mode === 'books' ? 'on' : ''}" data-m="books">Книги</button><button class="chip ${S.mode === 'authors' ? 'on' : ''}" data-m="authors">Авторы</button></div>
  <div id="res"></div>`;
  $('#sf').onsubmit = e => { e.preventDefault(); S.q = $('#sq').value.trim(); S.authorId = null; S.page = 0; S.items = []; S.authors = []; doSearch(); $('#sq').blur(); };
  view.querySelectorAll('[data-m]').forEach(c => c.onclick = () => { S.mode = c.dataset.m; S.authorId = null; S.page = 0; S.items = []; S.authors = []; search(); });
  doSearch(true);
}
let searchTok = 0; // номер последнего поиска: ответ на старый запрос не должен перезаписать новый
async function doSearch(restore) {
  const res = $('#res'); if (!res) return;
  const tok = ++searchTok;
  const authorsView = S.mode === 'authors' && !S.authorId;
  if (!S.q && !S.authorId) return res.innerHTML = S.mode === 'authors' ? '<div class="msg">Введите имя автора</div>' : genreGrid();
  const draw = more => {
    if (authorsView) { res.innerHTML = S.authors.map(a => `<a class="row" data-au="${a.id}"><div><b>${esc(a.name)}</b><small>Книг: ${Math.max(a.books, 0)}</small></div></a>`).join(''); return; }
    res.innerHTML = S.items.map(rowItem).join('') + (more ? '<button class="more" id="mb">Показать ещё</button>' : '');
  };
  const fresh = !restore || (!S.items.length && !S.authors.length);
  try {
    let more = false;
    if (fresh) {
      let box = res;
      if (S.page > 0 && S.items.length && !authorsView) { $('#mb')?.remove(); box = document.createElement('div'); res.appendChild(box); } // подгрузка: скелет снизу, список остаётся
      if (S.authorId) { const d = await apiLoad(`/api/author-books?id=${S.authorId}&page=${S.page}`, box, 'Загрузка книг автора'); if (tok !== searchTok) return; S.items = S.items.concat(reg(d.items)); more = d.hasNextPage; }
      else if (S.mode === 'authors') { const a = await apiLoad('/api/authors?q=' + encodeURIComponent(S.q), box, 'Поиск авторов'); if (tok !== searchTok) return; S.authors = a; }
      else { const d = await apiLoad(`/api/books?q=${encodeURIComponent(S.q)}&page=${S.page}`, box, 'Поиск книг'); if (tok !== searchTok) return; S.items = S.items.concat(reg(d.items)); more = d.hasNextPage; }
    } else more = S.more;
    S.more = more;
    if (authorsView ? !S.authors.length : !S.items.length) return res.innerHTML = '<div class="msg">Ничего не найдено</div>';
    draw(more);
    res.querySelectorAll('[data-au]').forEach(a => a.onclick = () => { S.authorId = a.dataset.au; S.page = 0; S.items = []; doSearch(); });
    const mb = $('#mb'); if (mb) mb.onclick = () => { S.page++; doSearch(); };
  } catch (e) { if (tok !== searchTok) return; res.innerHTML = `${errBox(e.message)}`; }
}
async function genre(key) {
  const g = GENRES.find(x => x[0] === key); if (!g) { location.hash = '#/search'; return; }
  view.innerHTML = `<button class="back" onclick="goBack('#/search')">${ic('left', 28)}</button><h1>${esc(g[1])}</h1><div id="glist"></div><div id="gsk">${SK.rows(3)}</div>`;
  const seen = new Set(); let pending = g[2].length, shown = 0;
  // каждый запрос показывает свои книги сразу, как только пришёл ответ
  g[2].forEach(async q => {
    let items = [];
    try { items = reg((await apiLoad(`/api/books?q=${encodeURIComponent(q)}&limit=10`, null)).items || []); } catch {}
    if (location.hash !== '#/genre/' + key) return;
    const list = $('#glist'); if (!list) return;
    const fresh = items.filter(b => !seen.has(b.id)); fresh.forEach(b => seen.add(b.id));
    list.insertAdjacentHTML('beforeend', fresh.map(rowItem).join('')); shown += fresh.length;
    if (--pending === 0) { $('#gsk')?.remove(); if (!shown) list.innerHTML = '<div class="msg">Не удалось загрузить книги. Попробуйте позже.</div>'; }
  });
}

/* ---------- библиотека ---------- */
let libTab = 'read';
function byStatus(st) {
  const ts = i => st === 'read' ? (prog[i]?.ts || bs[i]?.ts || 0) : (bs[i]?.ts || prog[i]?.ts || 0);
  return [...allIds()].filter(i => BOOKS[i] && statusOf(i) === st).sort((a, b) => ts(b) - ts(a) || shelf.indexOf(a) - shelf.indexOf(b)).map(i => BOOKS[i]);
}
function lib() {
  const L = { read: byStatus('read'), want: byStatus('want'), done: byStatus('done') };
  const qs = Object.keys(qt).flatMap(id => Object.entries(qt[id]).filter(([, v]) => !v.d).map(([k, v]) => ({ id, k, ...v }))).sort((a, b) => b.ts - a.ts);
  const ms = Object.keys(bm).flatMap(id => live(id).map(([, v]) => ({ id, ...v }))).sort((a, b) => b.ts - a.ts);
  const EMPTY = { read: 'Откройте любую книгу — она появится здесь', want: 'Откройте книгу, нажмите «В библиотеку» и выберите «Хочу прочитать»', done: 'Здесь будут книги, которые вы дочитали' };
  let body;
  if (libTab === 'marks') body = ms.length ? ms.map(m => `<a class="row" data-mk="${m.id}:${m.i}"><div><b>${esc(BOOKS[m.id]?.title || 'Книга')}</b><small>${Math.round((m.p || 0) * 100)}% · ${esc(m.x)}</small></div></a>`).join('') : '<div class="msg">Закладок пока нет</div>';
  else if (libTab === 'quotes') body = qs.length ? qs.map(q => `<div class="qc" data-qo="${q.id}:${q.i}"><div class="qx">«${esc(q.x)}»</div>${q.n ? `<div class="qn">${esc(q.n)}</div>` : ''}<div class="qm"><span>${esc(BOOKS[q.id]?.title || 'Книга')}</span><button data-qs="${q.id}:${q.k}" aria-label="Поделиться">${ic('share', 18)}</button><button data-qd="${q.id}:${q.k}" aria-label="Удалить">${ic('trash', 18)}</button></div></div>`).join('') : '<div class="msg">Удерживайте палец на абзаце в книге — и сохраните цитату или заметку</div>';
  else body = L[libTab].length ? L[libTab].map(rowLib).join('') : `<div class="msg">${EMPTY[libTab]}</div>`;
  const TABS = [['read', 'Читаю', L.read.length], ['want', 'Хочу прочитать', L.want.length], ['done', 'Прочитано', L.done.length], ['quotes', 'Цитаты', qs.length], ['marks', 'Закладки', ms.length]];
  view.innerHTML = `<h1>Библиотека</h1><div class="chips">${TABS.map(([k, n, c]) => `<button class="chip ${libTab === k ? 'on' : ''}" data-l="${k}">${n}${c ? ' · ' + c : ''}</button>`).join('')}</div>` + body;
  view.querySelectorAll('[data-l]').forEach(c => c.onclick = () => { libTab = c.dataset.l; lib(); });
  view.querySelectorAll('[data-st]').forEach(b => b.onclick = () => statusSheet(b.dataset.st, lib));
  view.querySelectorAll('[data-mk]').forEach(a => a.onclick = () => { const [id, i] = a.dataset.mk.split(':'); jump = { id, i: +i }; location.hash = '#/read/' + id; });
  view.querySelectorAll('[data-qo]').forEach(c => c.onclick = e => { if (e.target.closest('button')) return; const [id, i] = c.dataset.qo.split(':'); jump = { id, i: +i }; location.hash = '#/read/' + id; });
  view.querySelectorAll('[data-qs]').forEach(b => b.onclick = () => { const [id, k] = b.dataset.qs.split(':'); shareQuote(qt[id][k], id); });
  view.querySelectorAll('[data-qd]').forEach(b => b.onclick = () => { const [id, k] = b.dataset.qd.split(':'); qt[id][k] = { d: 1, ts: Date.now() }; store.set('qt', qt); saveBooks(); lib(); snack('Цитата удалена'); });
}

/* ---------- карточка книги ---------- */
function book(id) {
  const b = BOOKS[id]; if (!b) { location.hash = '#/'; return; }
  const [desc, ...meta] = descParts(b.description), p = prog[id], st = statusOf(id), has = OFF.has(id);
  const SL = { want: ['mark', 'Хочу прочитать'], read: ['play', 'Читаю'], done: ['check', 'Прочитано'] }[st] || ['plus', 'В библиотеку'];
  view.innerHTML = `<button class="back" onclick="goBack()">${ic('left', 28)}</button>
  <div class="hero">${cover(b, true)}<h1>${esc(b.title)}</h1><div class="au">${esc(authorOf(b))}</div>
  <div class="acts"><a class="btn" href="#/read/${id}">${p ? `Продолжить · ${Math.round(p.p * 100)}%` : 'Читать'}</a><button class="btn sec2" id="sh">${ic(SL[0], 18, st === 'want')} ${SL[1]}</button></div>
  <div class="subacts"><button class="chip fb" id="off">${ic(has ? 'check' : 'download', 16)} ${has ? 'Доступна офлайн' : 'Скачать для офлайна'}</button></div></div>
  <p class="desc">${esc(desc && desc.length > 20 ? desc : 'Описание отсутствует.')}</p>
  <div class="meta">${esc((b.categories || []).join(' · '))}<br>${esc(meta.filter(m => !/Скачиваний|Размер/.test(m)).join(' · '))}</div>`;
  $('#sh').onclick = () => statusSheet(id, () => book(id));
  $('#off').onclick = e => toggleOffline(id, e.currentTarget);
}

/* ---------- аккаунт и синхронизация (Firebase Realtime Database, REST, без Auth) ---------- */
const FB = 'https://neonapp-a05b0-default-rtdb.firebaseio.com'; // если в консоли другой адрес базы — поменяйте тут
let user = store.get('user', null), pulling = false, syncT = 0, syncMsg = '';
const keepIds = () => new Set([...allIds(), ...Object.keys(bm), ...Object.keys(qt)]);
const fb = async (path, method = 'GET', body) => {
  const r = await fetch(`${FB}/${path}.json`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Firebase закрыт: в Rules поставьте ".read": true, ".write": true' : 'Firebase ' + r.status);
  return r.json();
};
const pre = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => ['b' + k, v]));
const unpre = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.slice(1), v]));
const loginKey = l => l.trim().toLowerCase().replace(/[.$#\[\]\/\s]/g, '');
function queueSync() { if (!user || pulling) return; clearTimeout(syncT); syncT = setTimeout(push, 1500); }
const payload = () => {
  const books = Object.fromEntries([...keepIds()].filter(i => BOOKS[i]).map(i => [i, BOOKS[i]]));
  return { shelf, prog: pre(prog), bm: pre(bm), books: pre(books), set, st: ST.dev, sd: pre(sd), bs: pre(bs), qt: pre(qt) };
};
function merge(d) {
  const rp = unpre(d.prog); for (const id in rp) if (!prog[id] || (prog[id].ts || 0) < rp[id].ts) prog[id] = rp[id];
  const rsd = unpre(d.sd); for (const id in rsd) if ((sd[id] || 0) < rsd[id]) sd[id] = rsd[id];
  shelf = [...new Set([...Object.values(d.shelf || {}), ...shelf])].filter(i => !sd[i]);
  const rb = unpre(d.bm);
  for (const id in rb) { const o = { ...rb[id] }, l = bm[id] || {}; for (const k in l) if (!o[k] || (l[k].ts || 0) >= (o[k].ts || 0)) o[k] = l[k]; bm[id] = o; }
  const rbs = unpre(d.bs); for (const id in rbs) if (!bs[id] || (bs[id].ts || 0) < (rbs[id].ts || 0)) bs[id] = rbs[id];
  const rq = unpre(d.qt);
  for (const id in rq) { const o = { ...rq[id] }, l = qt[id] || {}; for (const k in l) if (!o[k] || (l[k].ts || 0) >= (o[k].ts || 0)) o[k] = l[k]; qt[id] = o; }
  BOOKS = { ...unpre(d.books), ...BOOKS };
  if (d.set) set = { ...set, ...d.set };
  for (const [id, m] of Object.entries(d.st || {})) if (id !== ST.id) ST.dev[id] = { days: m.days || {}, bk: m.bk || {} };
  store.set('sd', sd); store.set('bs', bs); store.set('qt', qt); store.set('shelf', shelf); store.set('prog', prog); store.set('bm', bm); store.set('set', set); store.set('st', ST); saveBooks(); applyApp();
}
async function push() {
  if (!user) return;
  try {
    await fb('data/' + user.login, 'PUT', { ...payload(), ts: Date.now() });
    syncMsg = 'Синхронизировано в ' + new Date().toTimeString().slice(0, 5);
  } catch (e) { syncMsg = 'Ошибка: ' + e.message; }
}
async function pull() {
  if (!user) return;
  try {
    const d = (await fb('data/' + user.login)) || {};
    pulling = true;
    merge(d);
  } catch (e) { syncMsg = 'Ошибка: ' + e.message; } finally { pulling = false; }
  await push();
}
async function auth(mode, login, pass) {
  const key = loginKey(login);
  if (key.length < 3) throw new Error('Логин — минимум 3 символа');
  if (pass.length < 4) throw new Error('Пароль — минимум 4 символа');
  const hash = (await (await fetch('/api/hash', { method: 'POST', body: JSON.stringify({ s: key + ':' + pass }) })).json()).hash;
  const ex = await fb('users/' + key);
  if (mode === 'reg') { if (ex) throw new Error('Такой логин уже занят'); await fb('users/' + key, 'PUT', { hash, created: Date.now() }); }
  else { if (!ex) throw new Error('Пользователь не найден'); if (ex.hash !== hash) throw new Error('Неверный пароль'); }
  user = { login: key }; store.set('user', user); await pull();
}
function live(id) { return Object.entries(bm[id] || {}).filter(([, v]) => !v.d); }

/* ---------- статистика чтения ---------- */
const dayKey = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const myDev = () => ST.dev[ST.id] ||= { days: {}, bk: {} };
const saveST = sync => { if (sync) store.set('st', ST); else try { localStorage.setItem('st', JSON.stringify(ST)); } catch {} };
let lastAct = Date.now(), tickN = 0;
['pointerdown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(e => addEventListener(e, () => lastAct = Date.now(), { passive: true, capture: true }));
setInterval(() => {
  if (!R || rd.hidden) return;
  const listening = TTS.playing;
  if (!listening && (document.hidden || Date.now() - lastAct > 120000)) return; // читаем только пока есть активность
  const m = myDev(), d = m.days[dayKey()] ||= { r: 0, l: 0 };
  if (listening) d.l += 5; else d.r += 5;
  m.bk['b' + R.id] = (m.bk['b' + R.id] || 0) + 5;
  tickN++; if (tickN % 6 === 0) saveST(tickN % 60 === 0);
}, 5000);
addEventListener('pagehide', () => saveST(false));
function stats() {
  const days = {}, bk = {};
  for (const m of Object.values(ST.dev)) {
    for (const k in m.days) { const a = days[k] ||= { r: 0, l: 0 }; a.r += m.days[k].r || 0; a.l += m.days[k].l || 0; }
    for (const k in m.bk) { const id = k.slice(1); bk[id] = (bk[id] || 0) + (m.bk[k] || 0); }
  }
  let r = 0, l = 0; for (const k in days) { r += days[k].r; l += days[k].l; }
  const di = k => { const [y, mo, d] = k.split('-').map(Number); return Math.round(Date.UTC(y, mo - 1, d) / 864e5); };
  const act = Object.keys(days).filter(k => days[k].r + days[k].l >= 60).map(di).sort((a, b) => a - b);
  let best = 0, run = 0; act.forEach((x, i) => { run = i && x === act[i - 1] + 1 ? run + 1 : 1; best = Math.max(best, run); });
  const have = new Set(act); let x = di(dayKey()), streak = 0; if (!have.has(x)) x--;
  while (have.has(x)) { streak++; x--; }
  return { days, bk, r, l, tot: r + l, best, streak, n: act.length };
}
const fmtDur = s => { const m = Math.round(s / 60); return m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин' : m + ' мин'; };
const ACC = { yellow: '#ffdb4d', mint: '#7ddf8f', sky: '#7cc4ff', pink: '#ff9ec7', orange: '#ffb066' };
const appDark = () => set.app === 'dark' || (!set.app && matchMedia('(prefers-color-scheme: dark)').matches);
const appBg = () => appDark() ? '#121214' : '#ffffff';
function applyApp() {
  document.documentElement.dataset.theme = set.app || '';
  document.documentElement.style.setProperty('--accent', ACC[set.acc] || ACC.yellow);
  document.querySelector('meta[name=theme-color]').content = rd.hidden ? appBg() : THEME_COLOR[set.th];
}
applyApp();

/* ---------- резервная копия ---------- */
function exportData() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload())], { type: 'application/json' }));
  a.download = 'books-backup-' + dayKey() + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- профиль ---------- */
let authMode = 'login', authErr = '';
const VN = { svetlana: 'Светлана', dmitry: 'Дмитрий' }, VG = { svetlana: 'жен.', dmitry: 'муж.', xenia: 'жен.', kseniya: 'жен.', baya: 'жен.', aidar: 'муж.', eugene: 'муж.' };
const sg = (k, items, cur, cls = '') => `<div class="seg ${cls}">${items.map(([v, t, st]) => `<button data-pa="${k}:${v}" class="${String(cur) === String(v) ? 'on' : ''}"${st ? ` style="${st}"` : ''}>${t}</button>`).join('')}</div>`;
async function pa(k, v, btn) {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  if (k === 'app') set.app = v === 'auto' ? '' : v;
  else if (k === 'acc') set.acc = v;
  else if (k === 'mode') set.mode = v; else if (k === 'th') set.th = v; else if (k === 'ff') set.ff = v;
  else if (k === 'fs') set.fs = clamp(set.fs + (v === '+' ? 1 : -1), 13, 32);
  else if (k === 'lh') set.lh = clamp(+(set.lh + (v === '+' ? .1 : -.1)).toFixed(1), 1.2, 2.2);
  else if (k === 'sv') set.sv = v; else if (k === 'eng') set.engine = v;
  else if (k === 'rate') set.rate = +v; else if (k === 'goal') set.goal = +v;
  else if (k === 'reset') { if (!confirm('Сбросить оформление и настройки читалки?')) return; set = { mode: 'page', fs: 19, ff: 'serif', th: 'light', lh: 1.6, rate: 1, goal: set.goal }; }
  else if (k === 'offclr') { if (!confirm('Удалить сохранённые тексты книг с устройства? Библиотека и прогресс останутся.')) return; for (const id of [...OFF.keys()]) await offDel(id); return me(); }
  else if (k === 'exp') return exportData();
  else if (k === 'imp') return $('#imp').click();
  else if (k === 'am') { authMode = v; authErr = ''; return me(); }
  else if (k === 'out') { user = null; store.set('user', null); syncMsg = ''; return me(); }
  else if (k === 'syn') { btn.textContent = 'Синхронизация…'; await pull(); return me(); }
  applyApp(); applySet(); me();
}
function me() {
  const s = stats(), fin = [...allIds()].filter(i => statusOf(i) === 'done').length;
  const goal = set.goal ?? 20, tod = s.days[dayKey()] || { r: 0, l: 0 }, todSec = tod.r + tod.l;
  const wk = [...Array(7)].map((_, i) => { const t = Date.now() - (6 - i) * 864e5, v = s.days[dayKey(t)] || { r: 0, l: 0 }; return { sec: v.r + v.l, d: 'вс пн вт ср чт пт сб'.split(' ')[new Date(t).getDay()], on: i === 6 }; });
  const mx = Math.max(goal * 60, ...wk.map(x => x.sec), 60);
  const dots = ['yellow', 'mint', 'sky', 'pink', 'orange'].map(c => [c, '', `background:${ACC[c]}`]);
  const th = [['light', 'Аа', 'background:#fff;color:#1c1c1e'], ['sepia', 'Аа', 'background:#f4ecd8;color:#4a3a2a'], ['gray', 'Аа', 'background:#3b3b3f;color:#d9d9dc'], ['dark', 'Аа', 'background:#000;color:#b4b4b8']];
  const stp = (k, val) => `<div class="seg"><button data-pa="${k}:-">−</button><button disabled style="opacity:.6">${val}</button><button data-pa="${k}:+">+</button></div>`;
  view.innerHTML = `<h1>Профиль</h1>
  <div class="hero"><div class="ava">${esc(user ? user.login[0].toUpperCase() : 'Г')}</div><h2 style="margin:10px 0 2px">${esc(user ? user.login : 'Гость')}</h2>
    <div style="color:var(--muted);font-size:14px">${esc(user ? syncMsg : 'Войдите внизу, чтобы всё было на всех устройствах')}</div></div>
  <div class="mini"><div><b>${fmtDur(todSec)}</b>сегодня</div><div><b>${s.streak}</b>дн. подряд</div><div><b>${fin}</b>прочитано</div></div>
  <div class="card">${goal ? `<div class="gl"><span>${Math.min(Math.round(todSec / 60), 999)} из ${goal} мин</span><span>${todSec >= goal * 60 ? '✓ цель выполнена' : 'осталось ' + fmtDur(goal * 60 - todSec)}</span></div><div class="bar big"><i style="width:${Math.min(100, todSec / (goal * 60) * 100)}%"></i></div>` : '<div class="gl"><span>Цель выключена, включите её в настройках ниже</span></div>'}
    <div class="chart">${wk.map(x => `<div class="col${x.on ? ' on' : ''}"><div class="bw"><i style="height:${Math.max(3, Math.round(x.sec / mx * 100))}%"></i></div><span>${x.d}</span></div>`).join('')}</div>
    <div class="meta" style="padding:12px 0 0;text-align:center">Всего ${fmtDur(s.tot)}${s.l ? ' · слушал ' + fmtDur(s.l) : ''}</div></div>
  <div class="card"><h2 style="margin:0 0 12px">Настройки</h2>
    <h4>Тема приложения</h4>${sg('app', [['auto', 'Авто'], ['light', 'Светлая'], ['dark', 'Тёмная']], set.app || 'auto')}
    <h4>Цвет акцента</h4>${sg('acc', dots, set.acc || 'yellow', 'dots')}
    <h4>Цель чтения (минут в день)</h4>${sg('goal', [[0, 'Выкл'], [10, '10'], [20, '20'], [30, '30'], [60, '60']], goal)}
    <h4>Режим чтения</h4>${sg('mode', [['page', 'Страницы'], ['scroll', 'Прокрутка']], set.mode)}
    <h4>Тема текста</h4>${sg('th', th, set.th, 'dots')}
    <h4>Шрифт</h4>${sg('ff', [['serif', 'С засечками', `font-family:${FONTS.serif}`], ['sans', 'Без засечек']], set.ff)}
    <h4>Размер текста</h4>${stp('fs', set.fs)}
    <h4>Межстрочный интервал</h4>${stp('lh', set.lh)}
    <h4>Озвучка: скорость</h4>${sg('rate', [.8, 1, 1.25, 1.5, 2].map(r => [r, r + '×']), set.rate || 1)}
    ${sileroOK ? `<h4>Голос озвучки</h4>${sg('sv', SP.map(x => [x, `${VN[x] || x} (${VG[x] || ''})`]), set.sv || SP[0], 'wrap')}` : '<div class="meta" style="padding:8px 0">Нейроголос подключается, это займёт около минуты.</div>'}
    <div style="display:grid;gap:10px;margin-top:14px"><button class="btn sec2" data-pa="reset:1">Сбросить настройки</button></div></div>
  <div class="card"><h2 style="margin:0 0 12px">Данные</h2><div style="display:grid;gap:10px">
    <button class="btn sec2" data-pa="exp:1">Сохранить резервную копию</button><button class="btn sec2" data-pa="imp:1">Восстановить из копии</button>${OFF.size ? `<button class="btn sec2" data-pa="offclr:1">Очистить офлайн-память · ${OFF.size}</button>` : ''}
    <input type="file" id="imp" accept="application/json,.json" hidden></div>
    <div class="meta" style="padding:10px 0 0">В копию входят статусы книг, прогресс, закладки, цитаты, настройки и статистика.</div></div>
  <div class="card"><h2 style="margin:0 0 12px">Аккаунт</h2>${user
    ? `<div style="display:grid;gap:10px"><button class="btn" data-pa="syn:1">${ic('sync', 18)} Синхронизировать</button><button class="btn sec2" data-pa="out:1">${ic('logout', 18)} Выйти</button></div>`
    : `<div class="meta" style="padding:0 0 10px">Место чтения, закладки, полка и статистика будут на всех ваших устройствах.</div>
  <div class="chips" style="padding:0 0 10px"><button class="chip ${authMode === 'login' ? 'on' : ''}" data-pa="am:login">Вход</button><button class="chip ${authMode === 'reg' ? 'on' : ''}" data-pa="am:reg">Регистрация</button></div>
  <form id="af"><div class="sbox" style="margin:0 0 10px"><input id="al" placeholder="Логин" autocapitalize="off" autocomplete="username"></div>
  <div class="sbox" style="margin:0 0 10px"><input id="ap" type="password" placeholder="Пароль" autocomplete="${authMode === 'reg' ? 'new-password' : 'current-password'}"></div>
  <div class="msg" id="ae" style="padding:4px 0;color:#e5484d">${esc(authErr)}</div>
  <button class="btn" style="width:100%">${authMode === 'reg' ? 'Создать аккаунт' : 'Войти'}</button></form>`}</div>`;
  view.onclick = e => { const b = e.target.closest('[data-pa]'); if (!b) return; const s = b.dataset.pa, j = s.indexOf(':'); pa(s.slice(0, j), s.slice(j + 1), b); };
  const imp = $('#imp');
  if (imp) imp.onchange = async () => {
    try { const d = JSON.parse(await imp.files[0].text()); if (!d || typeof d !== 'object') throw 0; pulling = true; merge(d); pulling = false; queueSync(); syncMsg = 'Копия восстановлена'; }
    catch { pulling = false; syncMsg = 'Не удалось прочитать файл копии'; }
    me();
  };
  const af = $('#af');
  if (af) af.onsubmit = async e => {
    e.preventDefault(); $('#ae').style.color = 'var(--muted)'; const t0 = Date.now(), tm = setInterval(() => { const a = $('#ae'); if (a) a.textContent = 'Подождите… ' + Math.round((Date.now() - t0) / 1000) + ' с'; }, 300); $('#ae').textContent = 'Подождите… 0 с';
    try { await auth(authMode, $('#al').value, $('#ap').value); clearInterval(tm); authErr = ''; me(); }
    catch (er) { clearInterval(tm); authErr = er.message; $('#ae').style.color = '#e5484d'; $('#ae').textContent = authErr; }
  };
}

/* ---------- читалка ---------- */
let R = null, saveT = 0, jump = null, lpT = 0, lpX = 0, lpY = 0, lpFired = false;
const $r = id => document.getElementById(id);
const applySet = () => {
  rd.dataset.th = set.th; rd.dataset.mode = set.mode;
  rd.style.setProperty('--fs', set.fs + 'px'); rd.style.setProperty('--lh', set.lh); rd.style.setProperty('--ff', FONTS[set.ff]);
  document.querySelector('meta[name=theme-color]').content = rd.hidden ? appBg() : THEME_COLOR[set.th];
  store.set('set', set);
};
function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; rd.appendChild(t); setTimeout(() => t.remove(), 1500); }
function topLimit() { const sc = $r('rscroll'); return sc.getBoundingClientRect().top + parseFloat(getComputedStyle(sc).paddingTop); }
function layout() {
  const sc = $r('rscroll'), w = $r('rwrap'), t = $r('rtext'); if (!sc) return;
  if (set.mode === 'page') {
    const cs = getComputedStyle(sc);
    const W = Math.min(680, Math.floor(sc.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)));
    const H = Math.floor(sc.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
    w.style.cssText = `width:${W}px;height:${H}px;overflow:hidden;margin:0 auto`;
    t.style.cssText = `width:${W}px;height:${H}px;column-width:${W}px;column-gap:0;column-fill:auto`;
    R.W = W; R.pages = Math.max(1, Math.round(w.scrollWidth / W));
  } else { w.style.cssText = ''; t.style.cssText = ''; sc.scrollLeft = 0; }
}
function cur() {
  const els = R.els; let lo = 0, hi = els.length - 1;
  if (set.mode === 'page') { const x = $r('rwrap').scrollLeft - 2; while (lo < hi) { const m = (lo + hi) >> 1; if (els[m].offsetLeft < x) lo = m + 1; else hi = m; } }
  else { const lim = topLimit() - 2; while (lo < hi) { const m = (lo + hi) >> 1; if (els[m].getBoundingClientRect().top < lim) lo = m + 1; else hi = m; } }
  return lo;
}
function goPara(i) {
  const el = R.els[Math.max(0, Math.min(i, R.els.length - 1))]; if (!el) return;
  if (set.mode === 'page') $r('rwrap').scrollLeft = Math.floor((el.offsetLeft + 2) / R.W) * R.W;
  else { const sc = $r('rscroll'); sc.scrollTop += el.getBoundingClientRect().top - topLimit(); }
  onPos();
}
function setFrac(f) {
  if (set.mode === 'page') $r('rwrap').scrollLeft = Math.round(f * (R.pages - 1)) * R.W;
  else { const sc = $r('rscroll'); sc.scrollTop = f * (sc.scrollHeight - sc.clientHeight); }
  onPos();
}
function turn(d) { const w = $r('rwrap'); w.scrollLeft = Math.max(0, Math.min(w.scrollWidth - R.W, w.scrollLeft + d * R.W)); onPos(); seekSoon(); }
function onPos() {
  const w = $r('rwrap'), sc = $r('rscroll'); if (!R || !w) return;
  const i = TTS.playing ? TTS.i : cur(), pc = (R.cum[i - 1] || 0) / R.total, min = Math.round(Math.max(0, R.total - (R.cum[i - 1] || 0)) / 1000);
  let f, label = '';
  if (set.mode === 'page') { const pg = Math.round(w.scrollLeft / R.W); f = R.pages > 1 ? pg / (R.pages - 1) : 0; label = `стр. ${pg + 1} из ${R.pages}`; }
  else { const m = sc.scrollHeight - sc.clientHeight; f = m > 0 ? sc.scrollTop / m : 0; }
  $r('rpct').textContent = [label, Math.round(pc * 100) + '%', `осталось ~${min >= 60 ? Math.floor(min / 60) + ' ч ' : ''}${min % 60} мин`].filter(Boolean).join(' · ');
  $r('rrange').value = f * 1000;
  const mi = $r('rmini'); if (mi) mi.textContent = [label, Math.round(pc * 100) + '%'].filter(Boolean).join(' · ');
  const mk = live(R.id).some(([, v]) => v.i === i); $r('rmk').innerHTML = ic('mark', 22, mk);
  const rid = R.id; clearTimeout(saveT); saveT = setTimeout(() => {
    prog[rid] = { p: pc, i, ts: Date.now() }; store.set('prog', prog);
    if (pc > .97 && statusOf(rid) !== 'done') { setStatus(rid, 'done'); snack('Книга прочитана — она теперь в разделе «Прочитано»'); }
    saveBooks();
  }, 500);
}
function toggleMark() {
  const i = cur(), m = bm[R.id] = bm[R.id] || {}, ex = live(R.id).find(([, v]) => v.i === i);
  if (ex) m[ex[0]] = { d: 1, ts: Date.now() };
  else m['t' + Date.now()] = { i, x: R.paras[i].t.slice(0, 90), ts: Date.now(), p: (R.cum[i - 1] || 0) / R.total };
  store.set('bm', bm); saveBooks(); toast(ex ? 'Закладка удалена' : 'Закладка добавлена'); onPos();
}
async function openReader(id) {
  const b = BOOKS[id]; if (!b) { location.hash = '#/'; return; }
  if (R?.id === id && !rd.hidden) return;
  rd.hidden = false; rd.className = ''; applySet(); document.body.style.overflow = 'hidden';
  rd.innerHTML = `<div class="rload"><div class="rl-cv">${cover(b, true)}</div><div class="rl-t">${esc(b.title)}</div><div class="rl-a">${esc(authorOf(b))}</div><div class="rl-bar"><i id="rlb"></i></div><div class="rl-s" id="rls">Сейчас-сейчас, открываем книгу…</div></div>`;
  try {
    // индикатор: полоса идёт по реальному среднему времени прошлых загрузок и добирает до 100% только когда книга пришла
    const t0 = performance.now(), typ = Math.max(2, lat['/api/read'] || 6);
    const tm = setInterval(() => {
      const bar = $r('rlb'), st = $r('rls'); if (!bar) return clearInterval(tm);
      const t = (performance.now() - t0) / 1000, p = Math.min(.94, 1 - Math.exp(-1.8 * t / typ));
      bar.style.width = (p * 100) + '%';
      st.textContent = t > typ * 1.6 ? 'Чуть дольше обычного, но уже скоро…' : p > .6 ? 'Почти готово…' : t > 1.5 ? 'Загружаем текст…' : 'Сейчас-сейчас, открываем книгу…';
    }, 120);
    let d; try {
      const cached = await offGet(id); // сохранённая на устройстве книга открывается мгновенно и без сети
      d = cached ? { paras: cached } : await (async () => { // если библиотека ответила не с первого раза — тихо пробуем ещё, пока не откроется
        let err; for (let n = 0; n < 3; n++) {
          try { return await apiLoad('/api/read?id=' + id, null, 'Загрузка книги'); }
          catch (er) { err = er; if (rd.hidden || /\(\d{3}\)/.test(er.message)) break; const st = $r('rls'); if (st) st.textContent = 'Книга подгружается, пробуем ещё раз…'; await new Promise(r => setTimeout(r, 1200)); }
        } throw err; })();
      if (!cached) offPut(id, d.paras, false);
    } finally { clearInterval(tm); }
    if (rd.hidden || location.hash !== '#/read/' + id) return;
    R = { id, paras: d.paras, heads: [] };
    let acc = 0; R.cum = d.paras.map(p => acc += p.t.length); R.total = acc || 1;
    const html = d.paras.map((p, i) => p.h ? (R.heads.push({ i, t: p.t }), `<h3>${esc(p.t)}</h3>`) : `<p>${esc(p.t)}</p>`).join('');
    rd.classList.add('hide'); // книга открывается на весь экран: панели скрыты, тап по центру их показывает
    rd.innerHTML = `<div class="rbar t"><button id="rx">${ic('left', 26)}</button><div class="tt">${esc(b.title)}</div><button id="rau">${ic('headphones', 22)}</button><button id="rmk">${ic('mark', 22)}</button><button id="rnav">${ic('menu', 22)}</button><button id="rset">${ic('type', 22)}</button></div>
      <div id="rscroll"><div id="rwrap"><div id="rtext">${html}</div></div></div>
      <div id="rmini"></div>
      <div class="rbar b"><input type="range" id="rrange" min="0" max="1000" value="0"><span id="rpct"></span><div id="rctl" hidden></div><div id="rst"></div></div>`;
    R.els = [...$r('rtext').children]; layout(); markQuotes();
    if (!['read', 'done'].includes(statusOf(id))) setStatus(id, 'read'); // открыли книгу — значит «Читаю»
    if (!store.get('hintQ', 0)) { store.set('hintQ', 1); setTimeout(() => { if (R && !rd.hidden) toast('Удерживайте абзац — сохранить цитату'); }, 1600); }
    const pr = prog[id];
    if (jump?.id === id) { goPara(jump.i); jump = null; } else if (pr) { pr.i != null ? goPara(pr.i) : setFrac(pr.p || 0); }
    const sc = $r('rscroll'); let tx = 0, ty = 0;
    // долгое нажатие на абзац — цитата или заметка
    sc.addEventListener('pointerdown', e => {
      lpFired = false; clearTimeout(lpT);
      const p = e.target.closest('#rtext p'); if (!p || document.querySelector('.panel')) return;
      lpX = e.clientX; lpY = e.clientY;
      lpT = setTimeout(() => { const i = R ? R.els.indexOf(p) : -1; if (i < 0) return; lpFired = true; navigator.vibrate?.(15); panel('quote', i); }, 480);
    });
    sc.addEventListener('pointermove', e => { if (Math.abs(e.clientX - lpX) > 10 || Math.abs(e.clientY - lpY) > 10) clearTimeout(lpT); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => sc.addEventListener(t, () => clearTimeout(lpT)));
    sc.addEventListener('contextmenu', e => { if (e.target.closest('#rtext')) e.preventDefault(); });
    sc.onscroll = () => { if (set.mode !== 'scroll') return; onPos(); if (TTS.show && Date.now() > (R.lock || 0)) seekSoon(); };
    sc.ontouchstart = e => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; };
    sc.ontouchend = e => { const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
      if (set.mode === 'page' && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) turn(dx < 0 ? 1 : -1); };
    sc.onclick = e => {
      if (lpFired) { lpFired = false; return; }
      if (document.querySelector('.panel')) return closePanel();
      if (set.mode === 'page') { const x = e.clientX / innerWidth; if (x < .3) return turn(-1); if (x > .7) return turn(1); }
      rd.classList.toggle('hide');
    };
    $r('rrange').oninput = e => setFrac(e.target.value / 1000); $r('rrange').onchange = () => seekSoon();
    $r('rau').onclick = () => TTS.show ? panel('audio') : speakFrom(cur());
    $r('rctl').onclick = e => { const c = e.target.closest('button')?.dataset.c; if (!c) return;
      if (c === 'p') TTS.playing ? pauseTTS() : speakFrom(TTS.i, TTS.k);
      if (c === 'f') speakFrom(TTS.i + 1); if (c === 'b') speakFrom(Math.max(0, TTS.i - 1));
      if (c === 's') { const r = [.8, 1, 1.25, 1.5, 2]; set.rate = r[(r.indexOf(set.rate) + 1) % r.length]; store.set('set', set); applyRate(); }
      if (c === 'o') panel('audio'); if (c === 'x') stopTTS(); };
    $r('rx').onclick = () => goBack(); $r('rmk').onclick = toggleMark;
    $r('rnav').onclick = () => panel('nav'); $r('rset').onclick = () => panel('set');
    onPos();
  } catch (e) {
    rd.innerHTML = `<div class="msg" style="padding-top:35vh">${errBox(e.message)}<br><div style="display:flex;gap:10px;justify-content:center"><button class="btn" onclick="openReader('${id}')">Повторить</button><button class="btn sec2" onclick="goBack()">Назад</button></div></div>`;
  }
}
window.addEventListener('resize', () => { if (R && !rd.hidden && $r('rwrap')) { const i = cur(); layout(); goPara(i); } });
window.addEventListener('keydown', e => { if (!R || rd.hidden || set.mode !== 'page' || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return; if (e.key === 'ArrowRight') turn(1); if (e.key === 'ArrowLeft') turn(-1); });
function closePanel() { document.querySelector('.panel')?.remove(); }
function markQuotes() {
  if (!R || !R.els) return;
  R.els.forEach(e => e.classList.remove('qd'));
  Object.values(qt[R.id] || {}).forEach(v => { if (!v.d) R.els[v.i]?.classList.add('qd'); });
}
function quotePanel(el, i) {
  const key = 'i' + i, ex = (qt[R.id] || {})[key], old = ex && !ex.d ? ex : null;
  el.innerHTML = `<h4>${old ? 'Цитата' : 'Новая цитата'}</h4><textarea id="qx" class="qta" rows="6">${esc(old ? old.x : R.paras[i].t)}</textarea><textarea id="qn" class="qta" rows="2" placeholder="Заметка (необязательно)">${esc(old?.n || '')}</textarea>
    <div class="qa"><button class="btn" id="qs">Сохранить</button><button class="btn sec2" id="qh" aria-label="Поделиться">${ic('share', 18)}</button>${old ? `<button class="btn sec2" id="qd" aria-label="Удалить">${ic('trash', 18)}</button>` : ''}</div>`;
  rd.appendChild(el);
  const val = () => ({ i, x: $r('qx').value.trim(), n: $r('qn').value.trim() });
  $r('qs').onclick = () => {
    const q = val(); if (!q.x) return toast('Цитата пустая');
    const m = qt[R.id] = qt[R.id] || {}; m[key] = { ...q, ts: Date.now(), p: (R.cum[i - 1] || 0) / R.total };
    store.set('qt', qt); saveBooks(); closePanel(); markQuotes(); toast(old ? 'Цитата обновлена' : 'Цитата сохранена');
  };
  $r('qh').onclick = () => { const q = val(); if (q.x) shareQuote(q, R.id); };
  const d = $r('qd'); if (d) d.onclick = () => { qt[R.id][key] = { d: 1, ts: Date.now() }; store.set('qt', qt); saveBooks(); closePanel(); markQuotes(); toast('Цитата удалена'); };
}
function panel(kind, tab = 'toc') {
  closePanel();
  const el = document.createElement('div'); el.className = 'panel';
  if (kind === 'audio') return audioPanel(el);
  if (kind === 'quote') return quotePanel(el, tab);
  if (kind === 'nav') {
    const tabs = [['toc', 'Содержание'], ['marks', 'Закладки'], ['quotes', 'Цитаты'], ['find', 'Поиск']];
    let body = '';
    if (tab === 'toc') body = R.heads.length ? R.heads.map(h => `<button data-i="${h.i}">${esc(h.t)}</button>`).join('') : '<div class="msg">В этой книге нет глав</div>';
    if (tab === 'marks') { const ms = live(R.id).sort((a, b) => a[1].i - b[1].i);
      body = ms.length ? ms.map(([k, v]) => `<div class="mk"><button data-i="${v.i}"><small>${Math.round((v.p || 0) * 100)}%</small> ${esc(v.x)}</button><button data-del="${k}">${ic('x', 18)}</button></div>`).join('') : '<div class="msg">Нажмите значок закладки вверху, чтобы добавить её</div>'; }
    if (tab === 'quotes') { const qs = Object.entries(qt[R.id] || {}).filter(([, v]) => !v.d).sort((a, b) => a[1].i - b[1].i);
      body = qs.length ? qs.map(([k, v]) => `<div class="mk"><button data-i="${v.i}"><small>${Math.round((v.p || 0) * 100)}%</small> ${esc(v.x.slice(0, 90))}</button><button data-qdel="${k}">${ic('x', 18)}</button></div>`).join('') : '<div class="msg">Удерживайте палец на абзаце, чтобы сохранить цитату</div>'; }
    if (tab === 'find') body = `<form class="sbox" id="ff" style="margin:0 0 10px"><input id="fq" placeholder="Слово или фраза" enterkeyhint="search"></form><div id="fr"></div>`;
    el.innerHTML = `<div class="chips" style="padding:0 0 10px">${tabs.map(([k, n]) => `<button class="chip ${k === tab ? 'on' : ''}" data-n="${k}">${n}</button>`).join('')}</div><div class="toc">${body}</div>`;
    el.onclick = e => {
      const d = e.target.closest('button')?.dataset || {};
      if (d.n) return panel('nav', d.n);
      if (d.i != null) { closePanel(); goPara(+d.i); seekSoon(+d.i); }
      if (d.del) { bm[R.id][d.del] = { d: 1, ts: Date.now() }; store.set('bm', bm); saveBooks(); panel('nav', 'marks'); onPos(); }
      if (d.qdel) { qt[R.id][d.qdel] = { d: 1, ts: Date.now() }; store.set('qt', qt); saveBooks(); markQuotes(); panel('nav', 'quotes'); }
    };
    rd.appendChild(el);
    const ff = $r('ff'); if (ff) ff.onsubmit = e => {
      e.preventDefault(); const q = $r('fq').value.trim().toLowerCase(); if (q.length < 2) return; const out = [];
      for (let i = 0; i < R.paras.length && out.length < 40; i++) { const t = R.paras[i].t, j = t.toLowerCase().indexOf(q);
        if (j >= 0) out.push(`<button data-i="${i}"><small>${Math.round((R.cum[i - 1] || 0) / R.total * 100)}%</small> …${esc(t.slice(Math.max(0, j - 30), j + 70))}…</button>`); }
      $r('fr').innerHTML = out.join('') || '<div class="msg">Ничего не найдено</div>'; $r('fq').blur();
    };
    return;
  }
  el.innerHTML = `<h4>Режим чтения</h4><div class="seg"><button data-md="page" class="${set.mode === 'page' ? 'on' : ''}">Страницы</button><button data-md="scroll" class="${set.mode === 'scroll' ? 'on' : ''}">Прокрутка</button></div>
  <h4>Размер текста</h4><div class="seg"><button data-a="fs-">A−</button><button disabled style="opacity:.6">${set.fs}</button><button data-a="fs+">A+</button></div>
  <h4>Шрифт</h4><div class="seg"><button data-f="serif" class="${set.ff === 'serif' ? 'on' : ''}" style="font-family:${FONTS.serif}">С засечками</button><button data-f="sans" class="${set.ff === 'sans' ? 'on' : ''}">Без засечек</button></div>
  <h4>Интервал</h4><div class="seg"><button data-a="lh-">Меньше</button><button data-a="lh+">Больше</button></div>
  <h4>Тема</h4><div class="seg dots">${[['light', '#fff', '#111'], ['sepia', '#f4ecd8', '#4a3a2a'], ['gray', '#3b3b3f', '#ddd'], ['dark', '#000', '#aaa']]
    .map(([t, bg, c]) => `<button data-t="${t}" class="${set.th === t ? 'on' : ''}" style="background:${bg};color:${c}">Аа</button>`).join('')}</div>`;
  el.onclick = e => {
    const d = e.target.closest('button')?.dataset; if (!d || !Object.keys(d).length) return;
    const i = cur();
    if (d.a === 'fs+') set.fs = Math.min(32, set.fs + 1); if (d.a === 'fs-') set.fs = Math.max(13, set.fs - 1);
    if (d.a === 'lh+') set.lh = Math.min(2.2, +(set.lh + .1).toFixed(1)); if (d.a === 'lh-') set.lh = Math.max(1.2, +(set.lh - .1).toFixed(1));
    if (d.f) set.ff = d.f; if (d.t) set.th = d.t; if (d.md) set.mode = d.md;
    applySet(); layout(); goPara(i); panel('set');
  };
  rd.appendChild(el);
}
/* ---------- озвучка (бесплатный синтез речи браузера) ---------- */
const tts = window.speechSynthesis;
const TTS = { show: false, playing: false, i: 0, k: 0, gen: 0, sleep: 0, sleepT: 0 };
let wl = null;
async function wake(on) {
  try { if (on && navigator.wakeLock && !wl) { wl = await navigator.wakeLock.request('screen'); wl.onrelease = () => wl = null; }
        else if (!on && wl) { await wl.release(); wl = null; } } catch {}
}
function chunks(t) {
  const out = [];
  for (const part of (t.match(/[^.!?…]+[.!?…]+["»)”]*\s*|[^.!?…]+$/g) || [t])) {
    let x = part.trim();
    while (x.length > 220) { let j = x.lastIndexOf(' ', 200); if (j < 50) j = 200; out.push(x.slice(0, j)); x = x.slice(j).trim(); }
    if (x) out.push(x);
  }
  return out;
}
/* перемотка: озвучка сразу переходит на то место, куда пользователь перелистнул */
let seekT = 0, seekForce = null;
function seekSoon(force) {
  if (force != null) seekForce = force;
  clearTimeout(seekT);
  seekT = setTimeout(() => { const f = seekForce; seekForce = null; doSeek(f); }, 350);
}
function doSeek(force) {
  if (!R || !TTS.show || rd.hidden) return;
  let i;
  if (force != null) i = force;
  else {
    const el = R.els[TTS.i]; let off;
    if (set.mode === 'page') off = !el || Math.floor((el.offsetLeft + 2) / R.W) !== Math.round($r('rwrap').scrollLeft / R.W);
    else { const r = el?.getBoundingClientRect(); off = !r || r.bottom < topLimit() || r.top > innerHeight; }
    if (!off) return; // озвучиваемый абзац всё ещё на экране
    i = cur();
  }
  if (TTS.playing) speakFrom(i);
  else { TTS.i = i; TTS.k = 0; TTS.key = null; au.pause(); markTTS(i); }
}
function drawCtl() {
  const c = $r('rctl'); if (!c || !R) return;
  const was = rd.classList.contains('aud');
  c.hidden = !TTS.show; rd.classList.toggle('aud', TTS.show);
  c.innerHTML = TTS.show ? `<button data-c="b">${ic('skipb', 22)}</button><button data-c="p" class="pp">${ic(TTS.playing ? 'pause' : 'play', 22, 1)}</button><button data-c="f">${ic('skipf', 22)}</button><button data-c="s" class="rate">${set.rate || 1}×</button><button data-c="o">${ic('sliders', 22)}</button><button data-c="x">${ic('x', 22)}</button>` : '';
  if (was !== TTS.show && $r('rwrap')) { const i = TTS.show && TTS.playing ? TTS.i : cur(); layout(); goPara(i); }
}
function markTTS(i) {
  if (R) R.lock = Date.now() + 700; // программная прокрутка не считается перемоткой пользователя
  document.querySelector('#rtext .tts')?.classList.remove('tts');
  const el = R.els[i]; if (!el) return; el.classList.add('tts'); TTS.fp = null;
  if (set.mode === 'page') TTS.fp = Math.floor((el.offsetLeft + 2) / R.W);
  if (set.mode === 'page') { if (Math.floor((el.offsetLeft + 2) / R.W) !== Math.round($r('rwrap').scrollLeft / R.W)) goPara(i); }
  else { const r = el.getBoundingClientRect(); if (r.top < topLimit() || r.bottom > innerHeight - 110) goPara(i); }
  onPos();
}
// длинный абзац может идти через несколько страниц: пока он звучит, листаем вслед за голосом (по доле проигранного времени)
function followPage() {
  if (!TTS.playing || !R || !(au.duration > 0)) return;
  const el = R.els[TTS.i], w = $r('rwrap'); if (!el || !w) return;
  const f = Math.min(1, au.currentTime / au.duration);
  if (set.mode === 'page') {
    const fr = [...el.getClientRects()]; if (fr.length < 2) return;
    const wr = w.getBoundingClientRect(), tot = fr.reduce((s, r) => s + r.height, 0) || 1;
    let acc = 0, pg = 0;
    for (const r of fr) { pg = Math.floor((r.left - wr.left + w.scrollLeft + 2) / R.W); acc += r.height / tot; if (f < acc) break; }
    const prev = TTS.fp ?? pg; TTS.fp = pg;
    // листаем только в момент, когда голос пересёк границу страницы, и никогда не возвращаем назад — ручное листание не ломается
    if (pg > prev && pg > Math.round(w.scrollLeft / R.W)) { R.lock = Date.now() + 700; w.scrollLeft = pg * R.W; onPos(); }
  } else {
    const r = el.getBoundingClientRect(), y = r.top + f * r.height;
    if (r.height > 120 && r.top < innerHeight && r.bottom > topLimit() && y > innerHeight - 200) { R.lock = Date.now() + 700; $r('rscroll').scrollTop += y - topLimit() - 80; onPos(); }
  }
}
function speakFrom(i, k = 0, checked) {
  // только нейроголос: если сервис ещё поднимается, проверяем заново и просим чуть подождать
  if (!sileroOK) { checkSilero().then(ok => { if (ok) speakSilero(i); else toast('Нейроголос подключается, попробуйте через минуту'); }); return; }
  return speakSilero(i);
  if (!tts) return toast('Этот браузер не поддерживает озвучку');
  tts.cancel(); const gen = ++TTS.gen;
  Object.assign(TTS, { show: true, playing: true, i, k }); wake(true); drawCtl();
  const run = () => {
    if (gen !== TTS.gen) return;
    const p = R?.paras[TTS.i]; if (!p) { stopTTS(); return toast('Конец книги'); }
    markTTS(TTS.i); const ch = chunks(p.t);
    const step = () => {
      if (gen !== TTS.gen) return;
      if (TTS.k >= ch.length) { TTS.i++; TTS.k = 0; return run(); }
      const u = new SpeechSynthesisUtterance(ch[TTS.k]); u.lang = 'ru-RU'; u.rate = set.rate || 1;
      const vs = tts.getVoices(), v = vs.find(v => v.name === set.voice) || vs.find(v => /^ru/i.test(v.lang)); if (v) u.voice = v;
      u.onend = () => { if (gen === TTS.gen) { TTS.k++; step(); } };
      u.onerror = e => { if (gen !== TTS.gen || e.error === 'interrupted' || e.error === 'canceled') return; pauseTTS(); toast('Ошибка озвучки: ' + e.error); };
      tts.speak(u);
    };
    step();
  };
  run();
}
/* ---------- Silero (нейронный голос с сервера) ---------- */
const au = new Audio(); au.preload = 'auto';
let sileroOK = false, SP = ['svetlana', 'dmitry'];
const checkSilero = () => fetch('/api/tts/status').then(r => r.json()).then(d => { sileroOK = !!d.ok; const sp = (d.speakers || []).filter(x => x === 'svetlana' || x === 'dmitry'); if (sp.length) SP = sp; return sileroOK; }).catch(() => false);
// сервис озвучки может подняться позже страницы: пока он недоступен, проверяем каждые 3 с (до 2 минут)
checkSilero().then(ok => { if (ok) return; let n = 0; const t = setInterval(async () => { if (await checkSilero() || ++n > 40) clearInterval(t); }, 3000); });
const eng = () => 'silero';
function applyRate() { au.playbackRate = set.rate || 1; if (eng() === 'browser' && TTS.playing) speakFrom(TTS.i, TTS.k); else drawCtl(); }
function waitUI(gen, p) {
  // короткая надпись без таймера; показывается, только если ждать пришлось дольше ~0,6 с
  const tm = setTimeout(() => { const st = $r('rst'); if (st && gen === TTS.gen && TTS.playing) st.textContent = 'Готовлю голос…'; }, 600);
  p.finally(() => { clearTimeout(tm); const st = $r('rst'); if (st) st.textContent = ''; });
}
/* озвучка: следующие абзацы скачиваются заранее, пока играет текущий, поэтому между абзацами нет пауз */
const AB = new Map(); // ключ -> { p: промис, url }
const abKey = (i, sp) => `${R.id}:${i}:${sp}`;
function abGet(i, sp) {
  const k = abKey(i, sp); if (AB.has(k)) return AB.get(k).p;
  const e = {};
  e.p = fetch(`/api/tts?id=${R.id}&i=${i}&sp=${sp}`).then(r => { if (!r.ok) throw 0; return r.blob(); })
    .then(b => (e.url = URL.createObjectURL(b))).catch(() => { AB.delete(k); return null; });
  AB.set(k, e); return e.p;
}
function abAhead(i, sp) {
  for (let n = 1; n <= 3; n++) if (R.paras[i + n]) abGet(i + n, sp);
  for (const [k, e] of AB) { const [id, j] = k.split(':'); if (id !== R.id || +j < i - 1 || +j > i + 6) { if (e.url) URL.revokeObjectURL(e.url); AB.delete(k); } }
}
function abClear() { for (const e of AB.values()) if (e.url) URL.revokeObjectURL(e.url); AB.clear(); }
function setMedia() {
  try {
    const m = navigator.mediaSession, b = BOOKS[R.id]; if (!m) return;
    m.metadata = new MediaMetadata({ title: b.title, artist: authorOf(b) });
    m.setActionHandler('play', () => speakFrom(TTS.i)); m.setActionHandler('pause', pauseTTS);
    m.setActionHandler('nexttrack', () => speakFrom(TTS.i + 1)); m.setActionHandler('previoustrack', () => speakFrom(Math.max(0, TTS.i - 1)));
  } catch {}
}
function speakSilero(i) {
  const sp = set.sv || SP[0], key = `${R.id}:${i}:${sp}`;
  if (TTS.show && TTS.key === key && au.paused && !au.ended && au.src) { TTS.playing = true; au.play().catch(() => {}); wake(true); drawCtl(); return; }
  tts?.cancel(); const gen = ++TTS.gen; au.pause(); // старый абзац не доигрывает после перемотки
  Object.assign(TTS, { show: true, playing: true, i, k: 0, key }); wake(true); drawCtl(); setMedia();
  au.onloadedmetadata = () => { au.playbackRate = set.rate || 1; };
  const fail = () => {
    if ((TTS.err = (TTS.err || 0) + 1) <= 3) { setTimeout(() => { if (gen === TTS.gen && TTS.playing) play(); }, 1500 * TTS.err); return; } // тихо пробуем ещё раз
    TTS.err = 0; TTS.key = null; pauseTTS(); toast('Нейроголос не ответил — нажмите ▶, чтобы продолжить');
  };
  const start = (i0, url) => {
    if (gen !== TTS.gen || TTS.i !== i0) return;
    if (!url) return fail();
    au.src = url; au.playbackRate = set.rate || 1;
    au.onended = () => { if (gen === TTS.gen) { TTS.i++; play(); } };
    au.onerror = () => { if (gen === TTS.gen) fail(); };
    au.onplaying = () => { TTS.err = 0; }; au.ontimeupdate = followPage;
    au.play().catch(() => {});
    abAhead(i0, sp);
  };
  const play = () => {
    if (gen !== TTS.gen) return;
    const p = R?.paras[TTS.i]; if (!p) { stopTTS(); return toast('Конец книги'); }
    TTS.key = `${R.id}:${TTS.i}:${sp}`; markTTS(TTS.i);
    const i0 = TTS.i, ready = AB.get(abKey(i0, sp))?.url;
    if (ready) return start(i0, ready); // уже скачан — играем сразу, без паузы
    const pr = abGet(i0, sp); waitUI(gen, pr); abAhead(i0, sp);
    pr.then(url => start(i0, url));
  };
  play();
}
function pauseTTS() {
  if (eng() === 'silero' && TTS.show) { au.pause(); TTS.playing = false; wake(false); drawCtl(); return; }
  TTS.gen++; tts?.cancel(); TTS.playing = false; wake(false); drawCtl();
}
function stopTTS() {
  TTS.gen++; tts?.cancel(); au.pause(); au.removeAttribute('src'); abClear(); TTS.key = null; clearTimeout(TTS.sleepT);
  Object.assign(TTS, { show: false, playing: false, sleep: 0 }); wake(false);
  document.querySelector('#rtext .tts')?.classList.remove('tts'); drawCtl();
}
function audioPanel(el) {
  const G = { svetlana: 'жен.', dmitry: 'муж.' }, N = { svetlana: 'Светлана', dmitry: 'Дмитрий' };
  el.innerHTML =
    (sileroOK ? `<h4>Голос</h4><div class="seg wrap">${SP.map(x => `<button data-sv="${x}" class="${(set.sv || SP[0]) === x ? 'on' : ''}">${N[x] || x} (${G[x] || ''})</button>`).join('')}</div>`
      : `<div class="meta" style="padding:0 0 12px">Нейроголос подключается, это займёт около минуты.</div>`) +
    `<h4>Скорость речи</h4><div class="seg">${[.8, 1, 1.25, 1.5, 2].map(r => `<button data-r="${r}" class="${set.rate === r ? 'on' : ''}">${r}×</button>`).join('')}</div>
    <h4 style="margin-top:16px">Таймер сна</h4><div class="seg">${[[0, 'Выкл'], [15, '15 мин'], [30, '30 мин'], [60, '60 мин']].map(([m, n]) => `<button data-sl="${m}" class="${TTS.sleep === m ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  el.onclick = e => {
    const d = e.target.closest('button')?.dataset; if (!d) return;
    if (d.sv) { set.sv = d.sv; store.set('set', set); TTS.key = null; if (TTS.show && TTS.playing && eng() === 'silero') speakSilero(TTS.i); panel('audio'); }
    if (d.r) { set.rate = +d.r; store.set('set', set); applyRate(); panel('audio'); }
    if (d.sl != null) { TTS.sleep = +d.sl; clearTimeout(TTS.sleepT); if (TTS.sleep) TTS.sleepT = setTimeout(() => { pauseTTS(); toast('Таймер сна: озвучка остановлена'); }, TTS.sleep * 6e4); panel('audio'); }
  };
  rd.appendChild(el);
}
if (tts) tts.getVoices();

function closeReader() {
  if (rd.hidden) return;
  saveST(true);
  stopTTS(); rd.hidden = true; rd.innerHTML = ''; R = null; document.body.style.overflow = ''; applySet();
}

route();
if (user) pull().then(() => { if (rd.hidden && !location.hash.startsWith('#/book')) route(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
