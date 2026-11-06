"""TTS-сервис: локальный Piper (быстрый, офлайн). Единственный голос — Орфей.
Запуск: python tts_server.py   (или через Node: автоматически вместе с server.js)
"""
import json, os, threading, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get('TTS_PORT', '5005'))

# ---------- Piper (локальный, быстрый, офлайн; модель качается при первом обращении) ----------
# Отключить: USE_PIPER=0. Зеркало Hugging Face: PIPER_MIRROR=https://hf-mirror.com
PIPER = {'ruslan': 'ru_RU-ruslan-medium'}
PIPER_DIR = os.environ.get('PIPER_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'piper_voices'))
PIPER_MIRROR = os.environ.get('PIPER_MIRROR', 'https://huggingface.co').rstrip('/')
PIPER_BITRATE = int(os.environ.get('PIPER_BITRATE', '160'))  # 22.05 кГц — это MPEG-2, максимум 160 kbps
piper_ok = False
PiperVoice = lameenc = None
_piper_cache = {}
if os.environ.get('USE_PIPER', '1') != '0':
    try:
        from piper import PiperVoice
        import lameenc
        piper_ok = True
        print('Piper доступен', flush=True)
    except Exception as e:
        print('Piper недоступен:', e, flush=True)

SPEAKERS = list(PIPER) if piper_ok else []
MODEL = 'piper' if piper_ok else 'off'
lock = threading.Lock()


def piper_ensure(name):
    """Путь к .onnx-модели; при отсутствии скачивает модель и конфиг с Hugging Face."""
    mid = PIPER[name]                                  # ru_RU-ruslan-medium
    lang, voice, quality = mid.split('-')              # ru_RU, ruslan, medium
    fam = lang.split('_')[0]                           # ru
    onnx = os.path.join(PIPER_DIR, mid + '.onnx')
    if os.path.exists(onnx) and os.path.exists(onnx + '.json'):
        return onnx
    os.makedirs(PIPER_DIR, exist_ok=True)
    base = f'{PIPER_MIRROR}/rhasspy/piper-voices/resolve/main/{fam}/{lang}/{voice}/{quality}/{mid}'
    for url, dst in ((base + '.onnx', onnx), (base + '.onnx.json', onnx + '.json')):
        print('Скачиваю голос Piper:', os.path.basename(dst), flush=True)
        tmp = dst + '.part'
        urllib.request.urlretrieve(url + '?download=true', tmp)
        os.replace(tmp, dst)
    return onnx


def synth_piper(text, speaker):
    with lock:
        v = _piper_cache.get(speaker)
        if v is None:
            v = PiperVoice.load(piper_ensure(speaker))  # ~1 с на первый вызов
            _piper_cache[speaker] = v
    sr = v.config.sample_rate
    enc = lameenc.Encoder()
    enc.set_bit_rate(PIPER_BITRATE); enc.set_in_sample_rate(sr); enc.set_channels(1); enc.set_quality(0)
    out = bytearray()
    for chunk in v.synthesize(text):
        out += enc.encode(chunk.audio_int16_bytes)
    out += enc.encode(bytes(int(sr * 0.3) * 2))         # небольшая пауза между абзацами
    out += enc.flush()
    return bytes(out), 'audio/mpeg'


def synth(text, speaker):
    if not (piper_ok and speaker in PIPER):
        raise RuntimeError('Голос недоступен')
    return synth_piper(text, speaker)


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/health'):
            return self._send(200, json.dumps({'ok': piper_ok, 'model': MODEL, 'speakers': SPEAKERS}).encode(), 'application/json')
        self._send(404, b'{}', 'application/json')

    def do_POST(self):
        if not self.path.startswith('/tts'):
            return self._send(404, b'{}', 'application/json')
        try:
            d = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            sp = d.get('speaker', 'ruslan')
            if sp not in SPEAKERS: sp = 'ruslan'
            body, ctype = synth(str(d.get('text', ''))[:6000], sp)
            self._send(200, body, ctype)
        except Exception as e:
            self._send(500, json.dumps({'error': str(e)}).encode(), 'application/json')

    def log_message(self, *a): pass


if __name__ == '__main__':
    print('TTS готов, модель:', MODEL, '| голоса:', ', '.join(SPEAKERS) or '—', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
