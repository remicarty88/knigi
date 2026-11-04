"""TTS-сервис: голоса Microsoft Edge (edge-tts, нужен интернет) + запасной Silero (локально, если установлен).
Запуск: python tts_server.py   (или через Node: автоматически вместе с server.js)
"""
import array, asyncio, io, json, os, re, threading, wave
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import edge_tts  # pip install edge-tts

PORT = int(os.environ.get('TTS_PORT', '5005'))
EDGE = {'svetlana': 'ru-RU-SvetlanaNeural', 'dmitry': 'ru-RU-DmitryNeural'}
EDGE_RATE = os.environ.get('EDGE_RATE', '+0%')   # например '-5%' для более спокойного темпа
EDGE_CHUNK = int(os.environ.get('EDGE_CHUNK', '350'))  # длинные абзацы режем на куски и озвучиваем параллельно
SILERO = ['xenia', 'kseniya', 'baya', 'aidar', 'eugene']

# ---------- Silero (необязательно) ----------
model = None
SR = int(os.environ.get('SILERO_SR', '24000'))
if os.environ.get('USE_SILERO', '0') != '0':   # по умолчанию выключен: тяжёлый и нужен только edge-tts
    try:
        import torch
        from silero import silero_tts
        torch.set_num_threads(int(os.environ.get('TORCH_THREADS', '4')))
        MODEL_ID = os.environ.get('SILERO_MODEL', 'v5_5_ru')
        try:
            model, _ = silero_tts(language='ru', speaker=MODEL_ID)
        except Exception:
            model, _ = silero_tts(language='ru', speaker='v5_ru')
        model.to(torch.device('cpu'))
        print('Silero загружен', flush=True)
    except Exception as e:
        print('Silero недоступен (ок, работаем на edge-tts):', e, flush=True)
SPEAKERS = list(EDGE) + (SILERO if model else [])
lock = threading.Lock()
pool = ThreadPoolExecutor(max_workers=8)


def split(text, limit=500):
    parts = re.findall(r'[^.!?…]+[.!?…]+["»”)]*\s*|[^.!?…]+$', text) or [text]
    out, cur = [], ''
    for p in parts:
        if len(cur) + len(p) <= limit:
            cur += p; continue
        if cur: out.append(cur)
        while len(p) > limit:
            j = p.rfind(' ', 0, limit); j = j if j > 50 else limit
            out.append(p[:j]); p = p[j:]
        cur = p
    if cur.strip(): out.append(cur)
    return [c.strip() for c in out if re.search(r'\w', c)]


def synth_silero(text, speaker):
    import torch
    gap = torch.zeros(int(SR * 0.25)); pieces = []
    with lock:
        for c in split(text):
            try:
                a = model.apply_tts(text=c, speaker=speaker, sample_rate=SR)
            except Exception:
                clean = re.sub(r'[^а-яёА-ЯЁa-zA-Z0-9 ,.!?:;\-]', ' ', c)
                try: a = model.apply_tts(text=clean, speaker=speaker, sample_rate=SR)
                except Exception as e: print('Пропущен кусок:', e, flush=True); continue
            pieces += [a.flatten(), gap]
    if not pieces: pieces = [torch.zeros(int(SR * 0.4))]
    pcm = torch.cat(pieces).clamp(-1, 1).mul(32767).short()
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(array.array('h', pcm.tolist()).tobytes())
    return buf.getvalue(), 'audio/wav'


async def _edge(text, voice):
    data = bytearray()
    async for ch in edge_tts.Communicate(text, voice, rate=EDGE_RATE).stream():
        if ch['type'] == 'audio':
            data += ch['data']
    return bytes(data)


def _edge_one(text, voice):
    last = None
    for attempt in range(3):
        try:
            data = asyncio.run(_edge(text, voice))
            if data: return data
        except Exception as e:
            last = e
    raise RuntimeError(f'edge-tts: {last}')


def synth_edge(text, speaker):
    text = re.sub(r'\s+', ' ', text).strip()
    voice = EDGE[speaker]
    chunks = split(text, EDGE_CHUNK) if len(text) > EDGE_CHUNK else [text]
    if len(chunks) == 1:
        return _edge_one(chunks[0], voice), 'audio/mpeg'
    # куски озвучиваются одновременно, mp3 склеивается подряд — длинный абзац готов за время самого долгого куска
    return b''.join(pool.map(lambda c: _edge_one(c, voice), chunks)), 'audio/mpeg'


def synth(text, speaker):
    if speaker in EDGE: return synth_edge(text, speaker)
    return synth_silero(text, speaker)


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/health'):
            return self._send(200, json.dumps({'ok': True, 'model': 'edge-tts', 'speakers': SPEAKERS}).encode(), 'application/json')
        self._send(404, b'{}', 'application/json')

    def do_POST(self):
        if not self.path.startswith('/tts'):
            return self._send(404, b'{}', 'application/json')
        try:
            d = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            sp = d.get('speaker', 'svetlana')
            if sp not in SPEAKERS: sp = 'svetlana'
            body, ctype = synth(str(d.get('text', ''))[:6000], sp)
            self._send(200, body, ctype)
        except Exception as e:
            self._send(500, json.dumps({'error': str(e)}).encode(), 'application/json')

    def log_message(self, *a): pass


if __name__ == '__main__':
    print('TTS готов, голоса:', ', '.join(SPEAKERS), flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
