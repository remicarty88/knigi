'use strict';
/* Полка — сервер приложения: раздача статики + шлюз /api?u=<url>.
   Запуск: node server.js   (порт из PORT, по умолчанию 8000)
   Шлюз нужен, потому что источники (knigavuhe, loveread) не отдают CORS-заголовки. */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '0.0.0.0';

/* Какие адреса разрешено проксировать. */
const ALLOWED = new Set([
  'm.knigavuhe.org',
  'knigavuhe.org',
  'www.knigavuhe.org',
  'loveread.ec',
  'www.loveread.ec',
]);

/* Резервный внешний шлюз — включается, только если источник ответил ошибкой
   или защитной страницей (DDoS-Guard не пускает датацентровые IP). */
const FALLBACK = url => 'https://r.jina.ai/' + url;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const json = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
};

/* ---------- Шлюз ---------- */

function decodeBody(buf, contentType) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  const label = (m ? m[1] : 'utf-8').toLowerCase();
  if (/^(utf-?8|ascii|us-ascii)$/.test(label)) return buf.toString('utf8');
  try { return new TextDecoder(label).decode(buf); } catch { return buf.toString('utf8'); }
}

const blocked = html => /ddos-guard|DDoS-Guard|Just a moment|Checking your browser/i.test(html.slice(0, 3000));

async function grab(url, extraHeaders) {
  const origin = new URL(url).origin;
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
      referer: origin + '/',
      ...extraHeaders,
    },
  });
}

async function proxy(req, res, target) {
  let u;
  try { u = new URL(target); } catch { return json(res, 400, { error: 'bad url' }); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return json(res, 400, { error: 'bad protocol' });
  if (!ALLOWED.has(u.hostname)) return json(res, 403, { error: 'host not allowed', host: u.hostname });

  let html = null;
  // Две попытки к источнику: он периодически отвечает ошибкой под нагрузкой
  // (например, когда пользователь слушает аудио и параллельно листает каталог).
  for (let attempt = 0; attempt < 2 && html === null; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 600));
    try {
      const r = await grab(u.href);
      const buf = Buffer.from(await r.arrayBuffer());
      const body = decodeBody(buf, r.headers.get('content-type'));
      if (r.status === 200 && !blocked(body)) html = body;
    } catch { /* следующая попытка или резервный шлюз */ }
  }

  if (html === null) {
    try {
      const r = await grab(FALLBACK(u.href), { 'x-return-format': 'html' });
      const buf = Buffer.from(await r.arrayBuffer());
      const body = decodeBody(buf, r.headers.get('content-type'));
      if (r.ok && !blocked(body)) html = body;
    } catch { /* ниже вернём 502 */ }
  }

  if (html === null) return json(res, 502, { error: 'upstream failed', url: u.href });

  const out = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': out.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=120',
  });
  res.end(req.method === 'HEAD' ? undefined : out);
}

/* ---------- Статика ---------- */

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, '.' + path.posix.normalize(rel));

  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) return json(res, 403, { error: 'forbidden' });

  let stat = await fsp.stat(file).catch(() => null);
  if (stat && stat.isDirectory()) {
    stat = await fsp.stat(path.join(file, 'index.html')).catch(() => null);
    if (stat) return sendFile(req, res, path.join(file, 'index.html'), stat);
  }
  if (!stat) return json(res, 404, { error: 'not found' });
  return sendFile(req, res, file, stat);
}

function sendFile(req, res, file, stat) {
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // код и документ не кэшируем — иначе обновления приложения не доедут
    'Cache-Control': name === 'sw.js' || ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------- Роутер ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS' });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });

  if (url.pathname === '/healthz') return json(res, 200, { ok: true });

  if (url.pathname === '/api') {
    const target = url.searchParams.get('u');
    if (!target) return json(res, 400, { error: 'missing ?u=' });
    return proxy(req, res, target);
  }

  try { return await serveStatic(req, res, url.pathname); }
  catch (e) { return json(res, 500, { error: String(e && e.message || e) }); }
});

server.listen(PORT, HOST, () => {
  console.log('Полка: http://localhost:' + PORT);
});
