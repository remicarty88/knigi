import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import FlibustaAPI from 'flibusta';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// .env читаем сами: флаг --env-file-if-exists есть только в Node 22.9+
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

// FLIBUSTA_URL может содержать несколько зеркал через запятую; первое — основное, остальные — запасные при чтении книг
const MIRRORS = [...new Set([...(process.env.FLIBUSTA_URL || '').split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean),
  'https://flibusta.is', 'https://flibusta.site'])];
const BASE = MIRRORS[0];
const PORT = process.env.PORT || 3000;
const PUB = fs.existsSync(path.join(ROOT, 'public')) ? path.join(ROOT, 'public') : ROOT;
const APIS = MIRRORS.map(m => new (FlibustaAPI.default ?? FlibustaAPI)(m));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут')), ms))]);
// библиотека иногда отвечает медленно (холодный поиск бывает 8–12 с) — таймаут выше, иначе отдаём 502
const API_TIMEOUT = +process.env.API_TIMEOUT || 20000;
// запрос к библиотеке: по очереди пробуем зеркала (у каждого свой таймаут), пока одно не ответит
let best = 0; const mirrorBad = new Map(); // best — зеркало, которое отвечало последним; mirrorBad — до какого времени зеркало считаем мёртвым
async function viaMirrors(call) {
  // спрашиваем самое живое зеркало; если оно молчит дольше 1,2 с, параллельно подключаются остальные — берём первый успешный ответ
  const now = Date.now(), dead = i => (mirrorBad.get(i) || 0) > now;
  const order = APIS.map((_, i) => i).sort((a, b) => (dead(a) - dead(b)) || (a === best ? -1 : b === best ? 1 : a - b));
  const hit = await new Promise(resolve => {
    let left = order.length, done = false;
    order.forEach((i, k) => setTimeout(() => {
      if (done) return;
      withTimeout((async () => call(APIS[i]))(), API_TIMEOUT).then(
        r => { if (!done) { done = true; best = i; mirrorBad.delete(i); resolve({ v: r }); } },
        e => { mirrorBad.set(i, Date.now() + 120000); console.log('api:', String(e.message || e).slice(0, 120)); if (--left === 0 && !done) resolve(null); });
    }, k * 1200));
  });
  if (hit) return hit.v;
  throw new Error('Библиотека пока не отвечает — обновите через минуту.');
}
const api = { getAuthors: q => viaMirrors(a => a.getAuthors(q)) };

const gzMem = new Map();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml' };
const wantsGzip = req => /\bgzip\b/.test(req?.headers?.['accept-encoding'] || '');
const json = (res, data, code = 200) => {
  let buf = Buffer.from(JSON.stringify(data ?? null));
  const h = { 'Content-Type': 'application/json; charset=utf-8' };
  if (buf.length > 1024 && wantsGzip(res.req)) { buf = zlib.gzipSync(buf); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }
  h['Content-Length'] = buf.length;
  res.writeHead(code, h);
  res.end(buf);
};

const cache = new Map();
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', hellip: '…' };
const decode = t => t.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1); return String.fromCodePoint(n || 32); }
  return ENT[e] ?? m;
});
// разбор HTML страницы «читать» в абзацы (без чистки)
function parsePage(h) {
  h = h.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  const m = h.match(/<body[^>]*>([\s\S]*)<\/body>/i); if (m) h = m[1];
  h = h.replace(/<h[1-6][^>]*>/gi, '\n@@H@@').replace(/<p[^>]*class=["']?title[^>]*>/gi, '\n@@H@@')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  return decode(h).split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .map(s => s.startsWith('@@H@@') ? { h: 1, t: s.slice(5).trim() } : { t: s }).filter(p => p.t);
}
// скачивание с таймаутом и повторами; на диск ничего не пишется — кэш только в памяти (сессия)
const pageJobs = new Map();
function fetchPage(id) {
  if (pageJobs.has(id)) return pageJobs.get(id);
  const job = (async () => {
    let last;
    for (let n = 1; n <= 4; n++) {
      const t0 = Date.now(), base = MIRRORS[(n - 1) % MIRRORS.length];
      try {
        const r = await fetch(`${base}/b/${id}/read`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(n === 1 ? 12000 : 20000) });
        if (!r.ok) throw new Error('Книга недоступна для чтения (' + r.status + ')');
        const paras = parsePage(await r.text());
        console.log(`read ${id}: ${paras.length} абз., ${Date.now() - t0} мс (${base})`);
        if (paras.length > 2) return paras;
        throw new Error('Пустая страница книги');
      } catch (e) {
        last = e; console.log(`read ${id}: попытка ${n} (${base}) не удалась — ${e.name === 'TimeoutError' ? 'таймаут' : e.message}`);
        if (/\((401|403|404|410)\)/.test(e.message) && n >= MIRRORS.length) break;
        await new Promise(r => setTimeout(r, 700 * n));
      }
    }
    throw new Error(/\(\d{3}\)/.test(last.message) ? last.message
      : 'Книга пока не открылась — сервер библиотеки отвечает медленно. Нажмите «Повторить», обычно со второй попытки всё загружается.');
  })();
  pageJobs.set(id, job);
  return job.finally(() => pageJobs.delete(id));
}
async function readBook(id) {
  if (cache.has(id)) return cache.get(id);
  const paras = await fetchPage(id);
  // чистим служебный мусор сайта: упоминания Флибусты, «скачать» и т.п. (только короткие строки, чтобы не задеть сам текст)
  const JUNK = /флибуст|flibusta|скачать|скачива|читать онлайн|электронная библиотека|полная версия книги|все книги автора|оценить книгу|\bfb2\b|\bepub\b/i;
  // шапка сайта («Книжное братство… Главная [Все] [А] [Б]…»): вырезаем и из середины строки, и целыми строками
  const HEAD = /Книжное братство\s*(?:Помощь и контакты)?\s*(?:Книжная полка)?\s*(?:Блоги)?\s*(?:Форумы)?\s*(?:Правила и ЧаВо)?\s*(?:Статистика)?\s*(?:Главная)?/gi;
  const BAR = /(?:\[[^\]\n]{1,40}\]\s*){4,}(?:\[[^\]\n]*)?/g;
  const NAV = /^(?:книжное братство|помощь и контакты|книжная полка|блоги|форумы|правила и чаво|статистика|главная)$/i;
  const clean = paras.map(p => ({ ...p, t: p.t.replace(HEAD, ' ').replace(BAR, ' ').replace(/\s+/g, ' ').trim() }))
    .filter(p => p.t && !NAV.test(p.t) && !(p.t.length < 160 && JUNK.test(p.t)));
  if (clean.length < 3) throw new Error('Не удалось получить текст книги');
  const out = { paras: clean };
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  cache.set(id, out);
  return out;
}

// ---------- озвучка Silero (Python-сервис) ----------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const TTS_URL = `http://127.0.0.1:${process.env.TTS_PORT || 5005}`;
const SPEAKERS = ['ruslan'];
const mimeOf = () => 'audio/mpeg'; // единственный голос — Piper (mp3)
// Сервис озвучки (Python + Piper) запускается сам, даже если стартовая команда на хостинге просто «node server.js».
// Отключить: флаг --no-tts или NO_TTS=1. Если piper-tts не поставился при сборке, он доустанавливается в ./pylibs.
const PYLIBS = path.join(HERE, 'pylibs');
const sh = (cmd, args, env = {}) => new Promise(res => {
  const p = spawn(cmd, args, { cwd: HERE, env: { ...process.env, ...env }, stdio: 'ignore' });
  p.on('error', () => res(false)); p.on('exit', c => res(c === 0));
});
async function startTTS() {
  const cands = [process.env.PYTHON, '/opt/venv/bin/python', 'python3', 'python'].filter(Boolean);
  let py = null;
  for (const c of cands) if (await sh(c, ['--version'])) { py = c; break; }
  if (!py) return console.log('Сервис озвучки не запустился: Python не найден. Читалка будет использовать системный голос браузера.');
  const env = { PYTHONPATH: [PYLIBS, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONUNBUFFERED: '1' };
  if (!(await sh(py, ['-c', 'import piper'], env))) {
    console.log('piper-tts не найден, доустанавливаю в ./pylibs …');
    await sh(py, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--target', PYLIBS, 'piper-tts', 'lameenc'], env);
  }
  let fails = 0;
  const run = () => {
    const t0 = Date.now();
    const p = spawn(py, ['tts_server.py'], { stdio: 'inherit', cwd: HERE, env: { ...process.env, ...env } });
    p.on('error', e => console.log(`Сервис озвучки не запустился (${e.message}). Читалка будет использовать системный голос браузера.`));
    p.on('exit', c => {
      console.log('tts_server завершился, код', c);
      if (Date.now() - t0 > 60000) fails = 0;
      if (++fails <= 5) setTimeout(run, 3000 * fails);
    });
    process.on('exit', () => p.kill());
  };
  run();
}
if (!process.argv.includes('--no-tts') && process.env.NO_TTS !== '1') startTTS();
// Голос синтезируется «в прямом эфире»: mp3 нигде не сохраняется на диск, только дедуп одновременных запросов в памяти.
const inflight = new Map();
async function ttsWav(id, i, sp) {
  const key = `${id}:${i}:${sp}`;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const p = (await readBook(id)).paras[i];
    if (!p) throw new Error('Нет такого абзаца');
    const r = await fetch(TTS_URL + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: p.t, speaker: sp }) });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'TTS: ' + r.status);
    }
    return Buffer.from(await r.arrayBuffer());
  })();
  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}
// Range-ответы нужны, чтобы <audio> работал в Safari/iOS
function sendAudio(req, res, buf, mime) {
  const total = buf.length, m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const h = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
  if (m) {
    const s = m[1] ? +m[1] : 0, e = Math.min(m[2] ? +m[2] : total - 1, total - 1);
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${s}-${e}/${total}`, 'Content-Length': e - s + 1 });
    return res.end(buf.subarray(s, e + 1));
  }
  res.writeHead(200, { ...h, 'Content-Length': total });
  res.end(buf);
}

// ---------- быстрые обложки: лимит параллельных запросов, дисковый и память-кэш ----------
let active = 0; const waitQ = [];
const run = fn => new Promise((res, rej) => {
  const go = () => { active++; fn().then(res, rej).finally(() => { active--; waitQ.shift()?.(); }); };
  active < 6 ? go() : waitQ.push(go);
});
const IMG_DIR = path.join(ROOT, 'cache', 'img'); fs.mkdirSync(IMG_DIR, { recursive: true });
const imgMem = new Map(), imgJobs = new Map(), imgBad = new Map();
const remember = (k, v) => { imgMem.set(k, v); if (imgMem.size > 300) imgMem.delete(imgMem.keys().next().value); return v; };
async function getImg(p) {
  const key = crypto.createHash('sha1').update(p).digest('hex');
  if (imgMem.has(key)) { const v = imgMem.get(key); imgMem.delete(key); imgMem.set(key, v); return v; }
  const f = path.join(IMG_DIR, key);
  try { return remember(key, { buf: fs.readFileSync(f + '.bin'), type: fs.readFileSync(f + '.ct', 'utf8'), key }); } catch {}
  if (Date.now() - (imgBad.get(key) || 0) < 600000) throw new Error('нет обложки');
  if (imgJobs.has(key)) return imgJobs.get(key);
  const job = run(async () => {
    try {
      let r = null, type = '';
      for (const m of [MIRRORS[best], ...MIRRORS.filter((_, k) => k !== best)]) {
        try {
          const x = await fetch(m + p, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
          const t = x.headers.get('content-type') || '';
          if (x.ok && t.startsWith('image/')) { r = x; type = t; break; }
        } catch {}
      }
      if (!r) throw new Error('img');
      const buf = Buffer.from(await r.arrayBuffer());
      try { fs.writeFileSync(f + '.bin', buf); fs.writeFileSync(f + '.ct', type); } catch { trimCache(true); }
      return remember(key, { buf, type, key });
    } catch (e) { imgBad.set(key, Date.now()); throw e; }
  });
  imgJobs.set(key, job);
  try { return await job; } finally { imgJobs.delete(key); }
}
// если по запросу ничего нет, библиотека может вернуть undefined/null — приводим к пустому списку
const norm = d => (d && Array.isArray(d.items)) ? d : { items: [], hasNextPage: false };
// как только пришёл список книг, фоном качаем их обложки — к моменту показа они уже у сервера
const warm = d => { for (const b of d?.items || []) if (typeof b.cover === 'string' && b.cover.startsWith('/i/')) getImg(b.cover).catch(() => {}); return d; };
// кэш ответов поиска на 10 минут (главная открывается мгновенно)
const apiMem = new Map(), apiJobs = new Map();
const API_DIR = path.join(ROOT, 'cache', 'api'); fs.mkdirSync(API_DIR, { recursive: true });
const apiFile = key => path.join(API_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
// поход в библиотеку с сохранением результата (в память и на диск); параллельные одинаковые запросы объединяются
function loadApi(key, fn) {
  if (apiJobs.has(key)) return apiJobs.get(key);
  const job = fn().then(d => {
    if (d && Array.isArray(d.items) && d.items.length) {
      apiMem.set(key, { t: Date.now(), d }); try { fs.writeFileSync(apiFile(key), JSON.stringify(d)); } catch {}
      if (apiMem.size > 300) apiMem.delete(apiMem.keys().next().value);
    }
    return d;
  }).finally(() => apiJobs.delete(key));
  apiJobs.set(key, job); return job;
}
// есть сохранённый ответ (пусть устаревший) — отдаём его мгновенно и обновляем в фоне; нет — ждём библиотеку
async function cached(key, fn, ttl = 600000) {
  let c = apiMem.get(key);
  if (!c) { try { const f = apiFile(key); c = { t: fs.statSync(f).mtimeMs, d: JSON.parse(fs.readFileSync(f, 'utf8')) }; apiMem.set(key, c); } catch {} }
  if (c) { if (Date.now() - c.t >= ttl) loadApi(key, fn).catch(() => {}); return c.d; }
  return loadApi(key, fn);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const booksFn = (q, page, limit) => () => viaMirrors(a => a.getBooksByNameFromOpdsPaginated(q, page, limit));

// ---------- прогрев: полки главной и первые книги подготавливаются заранее и обновляются раз в 30 минут ----------
// должен совпадать со списком полок в app.js (SHELVES); можно переопределить переменной WARM_QUERIES (через запятую)
const WARM_Q = (process.env.WARM_QUERIES || 'Шерлок Холмс,Дюна,Гарри Поттер,Война и мир,1984,Мастер и Маргарита').split(',').map(x => x.trim()).filter(Boolean);
let warming = false;
async function warmAll() {
  if (warming) return; warming = true;
  for (const q of WARM_Q) {
    try {
      const d = norm(await loadApi(`/api/books?q=${encodeURIComponent(q)}&limit=10`, booksFn(q, 0, 10)));
      warm(d);
      for (const b of (d.items || []).slice(0, 2)) { // тексты первых двух книг полки — чтобы открывались мгновенно
        const id = String(b.id ?? '').replace(/\D/g, '');
        if (id) { await fetchPage(id).catch(() => {}); await sleep(1500); }
      }
    } catch (e) { console.log('прогрев:', q, '—', String(e.message || e).slice(0, 100)); }
    await sleep(1000);
  }
  warming = false; console.log('прогрев завершён');
}
setTimeout(warmAll, 3000); setInterval(warmAll, 30 * 60 * 1000);

// ---------- лимит размера всей папки cache (CACHE_MB, по умолчанию 2000): самые старые файлы удаляются ----------
function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n), st = fs.statSync(p); st.isDirectory() ? walk(p, out) : out.push({ p, size: st.size, t: st.mtimeMs }); }
  return out;
}
function trimCache(urgent) {
  try {
    let max = (+process.env.CACHE_MB || 2000) * 1048576;
    const files = walk(CACHE); let total = files.reduce((a, f) => a + f.size, 0);
    let free = Infinity; try { const s = fs.statfsSync(CACHE); free = s.bavail * s.bsize; } catch {}
    if (urgent || free < 150 * 1048576) max = Math.min(max, total * 0.7); // место на исходе — освобождаем заметно больше
    if (total <= max) return;
    for (const f of files.sort((a, b) => a.t - b.t)) { if (total <= max * 0.85) break; try { fs.unlinkSync(f.p); total -= f.size; } catch {} }
    console.log('кэш почищен, осталось', Math.round(total / 1048576), 'МБ');
  } catch {}
}
setTimeout(trimCache, 20000); setInterval(trimCache, 3600000);

// ---------- Telegram-бот: приветствие «всё бесплатно» + кнопка-мини-приложение ----------
const BOT_TOKEN = process.env.BOT_TOKEN || '';
// на Railway публичный домен появляется сам, локально можно задать WEBAPP_URL=https://...
const WEBAPP_URL = (process.env.WEBAPP_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/+$/, '');
const HELLO = '📚 *Книги*\n\nВсе книги полностью *бесплатно*: без подписки, без оплаты и без регистрации.\nИскать, читать и слушать можно сколько угодно.\n\nОткрой приложение по кнопке ниже 👇';
const tg = (m, p) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${m}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p || {})
}).then(r => r.json()).catch(() => ({ ok: false }));
// web_app-кнопка требует https, иначе отдаём обычную ссылку
const openKB = () => {
  if (!WEBAPP_URL) return undefined;
  const btn = { text: '📚 Открыть приложение' };
  if (/^https:\/\//.test(WEBAPP_URL)) btn.web_app = { url: WEBAPP_URL }; else btn.url = WEBAPP_URL;
  return { inline_keyboard: [[btn]] };
};
async function startBot() {
  const me = await tg('getMe');
  if (!me.ok) return console.log('Telegram-бот не запущен:', me.description || 'неверный BOT_TOKEN');
  console.log('Telegram-бот запущен: @' + me.result.username);
  await tg('setMyCommands', { commands: [
    { command: 'start', description: 'Все книги бесплатно — открыть' },
    { command: 'app', description: 'Открыть приложение' },
    { command: 'help', description: 'Помощь' }] });
  if (/^https:\/\//.test(WEBAPP_URL))
    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Книги', web_app: { url: WEBAPP_URL } } });
  let off = 0;
  for (;;) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=50&offset=${off}`, { signal: AbortSignal.timeout(70000) });
      const d = await r.json();
      if (!d.ok) { await new Promise(r => setTimeout(r, 3000)); continue; }
      for (const u of d.result || []) {
        off = u.update_id + 1;
        const m = u.message || u.edited_message; if (!m) continue;
        await tg('sendMessage', { chat_id: m.chat.id, text: HELLO, parse_mode: 'Markdown', reply_markup: openKB() });
      }
    } catch { await new Promise(r => setTimeout(r, 3000)); }
  }
}
if (BOT_TOKEN) startBot();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const page = Number(q.get('page') || 0);
  try {
    if (url.pathname === '/api/books')
      return json(res, warm(norm(await cached(req.url, booksFn(q.get('q') || '', page, Number(q.get('limit') || 20))))));
    if (url.pathname === '/api/authors')
      return json(res, (await api.getAuthors(q.get('q') || '')) ?? []);
    if (url.pathname === '/api/author-books')
      return json(res, warm(norm(await cached(req.url, () => viaMirrors(a => a.getBooksByAuthorOpdsPaginated(q.get('id'), page, 20))))));
    // прокси обложек: кэш на диске и в памяти, браузер хранит год
    if (url.pathname === '/api/img') {
      const p = q.get('p') || '';
      if (!/^\/i\/[\w\-./%]+$/.test(p)) return json(res, { error: 'bad path' }, 400);
      let im; try { im = await getImg(p); } catch { res.writeHead(404); return res.end(); }
      if (req.headers['if-none-match'] === '"' + im.key + '"') { res.writeHead(304); return res.end(); }
      res.writeHead(200, { 'Content-Type': im.type, 'Content-Length': im.buf.length, 'Cache-Control': 'public, max-age=31536000, immutable', ETag: '"' + im.key + '"' });
      return res.end(im.buf);
    }
    // чтение: текст книги в виде абзацев (файлы не отдаются)
    if (url.pathname === '/api/read') {
      const id = (q.get('id') || '').replace(/\D/g, '');
      if (!id) return json(res, { error: 'bad id' }, 400);
      return json(res, await readBook(id));
    }
    if (url.pathname === '/api/tts/status') {
      try {
        const d = await (await fetch(TTS_URL + '/health', { signal: AbortSignal.timeout(1500) })).json();
        return json(res, { ok: !!d.ok, loading: !!d.loading, speakers: d.speakers || [], model: d.model });
      } catch { return json(res, { ok: false }); }
    }
    if (url.pathname === '/api/tts') {
      const id = (q.get('id') || '').replace(/\D/g, ''), i = parseInt(q.get('i'), 10), sp = q.get('sp') || 'ruslan';
      if (!id || !(i >= 0) || !SPEAKERS.includes(sp)) return json(res, { error: 'bad params' }, 400);
      const buf = await ttsWav(id, i, sp);
      return sendAudio(req, res, buf, mimeOf(sp));
    }
    // хеш пароля (в базу пароль в открытом виде не попадает)
    if (url.pathname === '/api/hash' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const { s = '' } = JSON.parse(body || '{}');
      return json(res, { hash: crypto.createHash('sha256').update('bookapp-v1:' + s).digest('hex') });
    }
    // статика: gzip и ETag (повторные открытия — 304 без передачи файла)
    const file = path.join(PUB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    let st; try { st = file.startsWith(PUB) ? fs.statSync(file) : null; } catch {}
    if (!st || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const h = { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + (/\.(html|css|js|json|svg)$/.test(file) ? '; charset=utf-8' : ''), 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
    if (/\.(html|css|js|json|svg)$/.test(file) && wantsGzip(req)) {
      let g = gzMem.get(file); if (!g || g.etag !== etag) { g = { etag, buf: zlib.gzipSync(fs.readFileSync(file)) }; gzMem.set(file, g); }
      res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': g.buf.length }); return res.end(g.buf);
    }
    res.writeHead(200, { ...h, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, { error: String(e.message || e) }, 502);
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
