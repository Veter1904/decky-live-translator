#!/usr/bin/python3
"""Decky Live Translator: capture helper (runs with the SYSTEM python3, which has GStreamer bindings).

One long-lived connection to the PipeWire node of gamescope; the appsink keeps only the newest frame (older ones are dropped,
no PipeWire buffer is held: holding buffers makes gamescope crash when the consumer disconnects). One frame is taken every
1/fps seconds as the sink has it (raw, BGRx on gamescope, no conversion) and kept in memory. A tiny HTTP server on 127.0.0.1
hands the latest frame to the plugin:
  GET /stats            -> json (frames, fps, cpu, node, restarts, size)
  GET /frame?after=N    -> raw bytes of the first frame with seq > N (long-poll, up to 5 s; 204 if none); X-W, X-H, X-Format
  GET /assets/<path>    -> a file from the plugin's assets folder (engine worker, Tesseract, scout worker)
  GET /clean            -> PNG of the game without Steam's layer (gamescope base-plane screenshot, slow and costly: rarely)
  GET /save             -> writes the latest frame to /tmp/dlt_frame.rgba (debug; one file, it is overwritten and removed when the helper stops)
  GET /quit             -> stops
usage: dlt_capture.py <port> <fps> <width> <height>
"""
import json, mmap, os, signal, struct, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib

Gst.init(None)
PORT, FPS, WIDTH, HEIGHT = int(sys.argv[1]), float(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
ENV = dict(os.environ, XDG_RUNTIME_DIR='/run/user/%d' % os.getuid())
TICKS = os.sysconf('SC_CLK_TCK')

cond = threading.Condition()
state = {'scaler': None, 'seq': 0, 'frame': b'', 'stamp': 0.0, 'restarts': 0, 'node': None, 'started': time.time(), 'last_error': '', 'w': 0, 'h': 0, 'fmt': '', 'source': '', 'layer_pid': 0, 'layer_game': 0, 'layer_frames': 0, 'fps': 0.0}
loop = GLib.MainLoop()
pipe = None
sink = None


def find_node():
    try:
        dump = json.loads(subprocess.run(['pw-dump'], capture_output=True, text=True, env=ENV, timeout=5).stdout)
    except Exception as e:
        state['last_error'] = 'pw-dump: %s' % e
        return None
    for o in dump:
        if o.get('type') == 'PipeWire:Interface:Node' and o['info']['props'].get('node.name') == 'gamescope':
            return str(o['id'])
    return None


def cpu_seconds():
    parts = open('/proc/self/stat').read().rsplit(')', 1)[1].split()
    return (int(parts[11]) + int(parts[12])) / TICKS



# ---- frames from the Vulkan layer (the game's own picture, before gamescope and Steam compose anything) ----
# /dev/shm is shared with the container of a game, XDG_RUNTIME_DIR is not
LAYER_DIR = '/dev/shm/dlt-%d' % os.getuid()
LAYER_FRAME = os.path.join(LAYER_DIR, 'frame')
LAYER_ENABLE = os.path.join(LAYER_DIR, 'enable')
LAYER_HEADER = 4096
# VkFormat -> the name the plugin's worker converts from
LAYER_FORMATS = {37: 'RGBA', 43: 'RGBA', 44: 'BGRx', 50: 'BGRx', 64: 'ABGR2101010', 58: 'ARGB2101010'}
layer = {'fd': None, 'mm': None, 'size': 0, 'last_seq': 0}


def layer_enable():
    """Tells the layer that frames are wanted (the file is touched every 2 s; the layer ignores a file that nobody touches)."""
    try:
        os.makedirs(LAYER_DIR, exist_ok=True)
        with open(LAYER_ENABLE, 'w') as f:
            f.write('%d' % max(100, int(1000 / FPS)))
    except OSError as e:
        state['last_error'] = 'layer enable: %s' % e
    return True


def layer_disable():
    try:
        os.remove(LAYER_ENABLE)
    except OSError:
        pass


def layer_frame():
    """Publishes the newest frame of the layer, if there is a fresh one. Returns True when a frame was taken."""
    try:
        st = os.stat(LAYER_FRAME)
    except OSError:
        return False
    # A file that was removed and made again (the same size, another file) must be opened again: the map of the old one never gets another frame
    if layer['mm'] is None or st.st_size != layer['size'] or (st.st_ino, st.st_dev) != layer.get('id'):
        if layer['mm'] is not None:
            layer['mm'].close()
            os.close(layer['fd'])
            layer['mm'] = None
        if st.st_size < LAYER_HEADER:
            return False
        layer['fd'] = os.open(LAYER_FRAME, os.O_RDONLY)
        layer['mm'] = mmap.mmap(layer['fd'], 0, prot=mmap.PROT_READ)
        layer['size'] = st.st_size
        layer['id'] = (st.st_ino, st.st_dev)
        layer['last_seq'] = 0
    mm = layer['mm']
    magic, version, seq, w, h, fmt, stride, ns, pid, gid = struct.unpack_from('<IIQIIIIQII', mm, 0)
    if magic != 0x46544c44 or seq == 0 or seq & 1 or seq == layer['last_seq']:
        return False
    if abs(time.time_ns() - ns) > 2000000000 or fmt not in LAYER_FORMATS:
        return False            # not fresh (the game is gone) or a format we cannot read
    n = w * h * 4
    if w < 1 or h < 1 or LAYER_HEADER + n > len(mm):
        return False
    data = mm[LAYER_HEADER:LAYER_HEADER + n]
    if struct.unpack_from('<Q', mm, 8)[0] != seq:
        return False            # the layer was writing while we read
    layer['last_seq'] = seq
    # The frame rate of the game: the layer counts two for every frame it writes (odd while writing, even when done)
    now = time.time()
    if layer.get('fps_t') is None or now - layer['fps_t'] > 5:
        layer['fps_t'], layer['fps_seq'] = now, seq
    elif now - layer['fps_t'] >= 1.0:
        state['fps'] = round(max(0.0, (seq - layer['fps_seq']) / 2.0 / (now - layer['fps_t'])), 1)
        layer['fps_t'], layer['fps_seq'] = now, seq
    with cond:
        state['seq'] += 1
        state['frame'] = data
        state['stamp'] = time.time()
        state['w'], state['h'], state['fmt'] = w, h, LAYER_FORMATS[fmt]
        state['source'] = 'layer'
        state['layer_pid'], state['layer_game'] = pid, gid
        state['layer_frames'] += 1
        layer['seen'] = time.time()
        cond.notify_all()
    return True



# ---- Recording for the developer: the frames (and what the translator showed) of the next N seconds, saved on the card ----
import queue, zlib
from dlt_retention import RECORD_KEEP, RECORD_MAX_AGE_DAYS, RECORD_MAX_BYTES, clear_recordings, count_recordings, dir_bytes, prune_recordings, remove_files, truncate_if_big
RECORD_ROOT = os.path.join(os.path.expanduser('~'), 'dlt-records')
record = {'dir': None, 'until': 0.0, 'n': 0, 'last_seq': 0, 'q': queue.Queue(), 'saved': 0}


def record_writer():
    while True:
        item = record['q'].get()
        if item is None:
            return
        folder, n, data, meta = item
        try:
            with open(os.path.join(folder, 'f%03d.raw.z' % n), 'wb') as f:
                f.write(zlib.compress(data, 1))
            with open(os.path.join(folder, 'index.jsonl'), 'a') as f:
                f.write(json.dumps(meta) + chr(10))
            record['saved'] += 1
        except OSError:
            pass


def record_prune(keep=RECORD_KEEP):
    """The recordings that are too many, too big together or too old are removed (see dlt_retention.py). Returns how many bytes are left."""
    return prune_recordings(RECORD_ROOT, keep, RECORD_MAX_BYTES, RECORD_MAX_AGE_DAYS)


def record_clear():
    """All recordings are removed (not the one that is being made)."""
    clear_recordings(RECORD_ROOT, record['dir'] if record['dir'] and time.time() < record['until'] else None)


def record_start(seconds):
    if record['dir'] and time.time() < record['until']:
        return record['dir']
    os.makedirs(RECORD_ROOT, exist_ok=True)
    # one place for the new recording: of the old ones only the newest (KEEP - 1) stay
    record_prune(RECORD_KEEP - 1)
    folder = os.path.join(RECORD_ROOT, time.strftime('%Y%m%d-%H%M%S'))
    os.makedirs(folder, exist_ok=True)
    record.update(dir=folder, until=time.time() + seconds, n=0, last_seq=0, saved=0)
    return folder


def record_tick():
    """Called on every tick: keeps a copy of each new frame while a recording runs."""
    if not record['dir'] or time.time() > record['until']:
        return
    with cond:
        seq, data = state['seq'], state['frame']
        meta = {'n': record['n'], 't': time.time(), 'seq': seq, 'w': state['w'], 'h': state['h'], 'fmt': state['fmt'], 'source': state['source']}
    if seq == record['last_seq'] or not data or record['q'].qsize() > 6:
        return
    record['last_seq'] = seq
    record['q'].put((record['dir'], record['n'], data, meta))
    record['n'] += 1


def tick():
    record_tick()
    return tick_frame()


def tick_frame():
    """Takes the latest frame the sink holds (the sink keeps only one and drops the older ones; no per-frame work happens here)."""
    # The game's own frame from the layer is better: no Steam layer, no plates, the game's resolution
    if layer_frame():
        return True
    # A game that presents rarely (a still scene) or a pause of the layer: no new frame, but never the screen's picture meanwhile
    # (it has our plates in it and the translator would read them as the game's text)
    if time.time() - layer.get('seen', 0) < 30:
        return True
    if sink is None:
        return True
    sample = sink.emit('try-pull-sample', 0)
    if sample is None:
        return True
    buf = sample.get_buffer()
    ok, info = buf.map(Gst.MapFlags.READ)
    if not ok:
        return True
    data = bytes(info.data)
    buf.unmap(info)
    caps = sample.get_caps().get_structure(0)
    with cond:
        state['seq'] += 1
        state['frame'] = data
        state['stamp'] = time.time()
        state['w'] = caps.get_value('width')
        state['h'] = caps.get_value('height')
        state['fmt'] = caps.get_value('format')
        state['source'] = 'pipewire'
        cond.notify_all()
    return True


def on_message(bus, msg):
    if msg.type == Gst.MessageType.ERROR:
        err, dbg = msg.parse_error()
        state['last_error'] = str(err)
        GLib.timeout_add(1000, restart)
    elif msg.type == Gst.MessageType.EOS:
        GLib.timeout_add(1000, restart)


def build():
    global pipe, sink
    node = find_node()
    state['node'] = node
    if node is None:
        GLib.timeout_add(1000, restart)
        return
    # No valve, no conversion: a valve between the source and the rest made gamescope flip the stream between paused and
    # streaming for every frame (wireplumber 13 % of a core). The sink holds only the newest frame (drop, one buffer).
    pipe = Gst.parse_launch('pipewiresrc path=%s do-timestamp=true ! appsink name=s caps=video/x-raw drop=true max-buffers=1 sync=false' % node)
    sink = pipe.get_by_name('s')
    bus = pipe.get_bus()
    bus.add_signal_watch()
    bus.connect('message', on_message)
    pipe.set_state(Gst.State.PLAYING)


def restart():
    global pipe
    if pipe is not None:
        pipe.set_state(Gst.State.NULL)
        pipe = None
    state['restarts'] += 1
    build()
    return False


SHOT_PATH = '/tmp/gamescope.png'
DEBUG_FRAME = '/tmp/dlt_frame.rgba'
SHOT_LOCK = threading.Lock()
SHOT_DISPLAY = os.environ.get('DLT_X_DISPLAY', ':0')


def clean_shot(timeout=2.0, kind='1'):
    """The picture of the GAME without Steam's layer (our plates are not in it): asks gamescope for a base-plane screenshot
    (what Steam itself does) and returns the PNG, or None. Expensive for gamescope (a PNG is encoded), so only now and then."""
    with SHOT_LOCK:
        try:
            old = os.stat(SHOT_PATH).st_mtime_ns
        except OSError:
            old = 0
        t0 = time.time()
        env = dict(ENV, DISPLAY=SHOT_DISPLAY)
        subprocess.run(['xprop', '-root', '-f', 'GAMESCOPECTRL_REQUEST_SCREENSHOT', '32c', '-set', 'GAMESCOPECTRL_REQUEST_SCREENSHOT', kind],
                       env=env, capture_output=True, timeout=5)
        while time.time() - t0 < timeout:
            try:
                if os.stat(SHOT_PATH).st_mtime_ns != old:
                    with open(SHOT_PATH, 'rb') as f:
                        data = f.read()
                    if data[-12:][4:8] == b'IEND':
                        return data
            except OSError:
                pass
            time.sleep(0.01)
        return None


def game_fps():
    """The frame rate of the game as the layer saw it a moment ago (0 when no frame has come for a while: the game is paused or gone)."""
    if state['source'] != 'layer' or not state['stamp'] or time.time() - state['stamp'] > 2.5:
        return 0
    return state['fps']


def scaler_watch():
    """Follows the Scaling mode of gamescope without asking over and over: xprop -spy writes a line when the setting changes (zero work in between)."""
    while True:
        try:
            proc = subprocess.Popen(['xprop', '-root', '-spy', 'GAMESCOPE_NEW_SCALING_SCALER'], env=dict(ENV, DISPLAY=SHOT_DISPLAY), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            for line in proc.stdout:
                if '=' in line:
                    try:
                        state['scaler'] = int(line.split('=')[1].strip().split(',')[0])
                    except ValueError:
                        pass
            proc.wait()
        except Exception:
            pass
        time.sleep(5)


def cleanup_leftovers(final=False):
    """What the helper leaves in /tmp is removed: the screenshot, the debug frame, and the log of the layer when it has grown big.
    Old debug frames of earlier versions (dlt_frame_<n>.rgba) go too."""
    # The shared frame of the layer is NOT removed: a game that is running keeps it open and goes on writing to it; if it were unlinked, the next start of the translator would find no frames of the game
    names = [DEBUG_FRAME, SHOT_PATH] if final else []
    try:
        names += [os.path.join('/tmp', n) for n in os.listdir('/tmp') if n.startswith('dlt_frame_') and n.endswith('.rgba')]
    except OSError:
        pass
    remove_files(names)
    truncate_if_big(os.path.join(LAYER_DIR, 'layer.log'), 200000)


def shutdown(*_):
    global pipe
    layer_disable()
    cleanup_leftovers(final=True)
    if pipe is not None:
        pipe.set_state(Gst.State.NULL)
        pipe = None
    loop.quit()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body=b'', ctype='application/octet-stream', headers=None):
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Expose-Headers', 'X-Seq, X-W, X-H, X-Format, X-Source, X-Age-Ms, X-Scaler, X-Fps')
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = self.path.partition('?')[0]
        length = int(self.headers.get('Content-Length', '0') or 0)
        body = self.rfile.read(min(length, 1 << 20))
        if path == '/record/note' and record['dir']:
            try:
                with open(os.path.join(record['dir'], 'plates.jsonl'), 'ab') as f:
                    f.write(body.replace(bytes([10]), b' ') + bytes([10]))
            except OSError:
                pass
            return self._send(200, b'ok')
        self._send(404)

    def do_GET(self):
        path, _, query = self.path.partition('?')
        if path == '/stats':
            up = max(time.time() - state['started'], 0.001)
            out = {'seq': state['seq'], 'fps': round(state['seq'] / up, 2), 'cpu_pct': round(100 * cpu_seconds() / up, 1),
                   'node': state['node'], 'restarts': state['restarts'], 'w': state['w'], 'h': state['h'], 'fmt': state['fmt'], 'source': state['source'], 'layer_frames': state['layer_frames'], 'layer_game': state['layer_game'], 'game_fps': game_fps(), 'age_ms': int(1000 * (time.time() - state['stamp'])) if state['stamp'] else None,
                   'error': state['last_error']}
            return self._send(200, json.dumps(out).encode(), 'application/json')
        if path == '/frame':
            after = int(dict(p.split('=') for p in query.split('&') if '=' in p).get('after', '0'))
            with cond:
                cond.wait_for(lambda: state['seq'] > after, timeout=5)
                if state['seq'] <= after:
                    return self._send(204)
                data, seq, stamp = state['frame'], state['seq'], state['stamp']
                w, h, fmt, source = state['w'], state['h'], state['fmt'], state['source']
            return self._send(200, data, headers={'X-Seq': seq, 'X-W': w, 'X-H': h, 'X-Format': fmt, 'X-Source': source, 'X-Age-Ms': int(1000 * (time.time() - stamp)), 'X-Scaler': state['scaler'] if state['scaler'] is not None else -1, 'X-Fps': game_fps()})
        if path == '/scaler':
            # How gamescope puts the game on the screen: the setting "Scaling mode" of Steam (0 auto, 1 integer, 2 fit, 3 fill, 4 stretch) and the filter
            out = {}
            for name in ('GAMESCOPE_NEW_SCALING_SCALER', 'GAMESCOPE_NEW_SCALING_FILTER'):
                try:
                    r = subprocess.run(['xprop', '-root', name], env=dict(ENV, DISPLAY=SHOT_DISPLAY), capture_output=True, timeout=3, text=True)
                    out[name] = int(r.stdout.split('=')[1].strip().split(',')[0])
                except Exception:
                    out[name] = None
            return self._send(200, json.dumps({'scaler': out['GAMESCOPE_NEW_SCALING_SCALER'], 'filter': out['GAMESCOPE_NEW_SCALING_FILTER']}).encode(), 'application/json')
        if path == '/clean':
            t0 = time.time()
            q = dict(p.split('=') for p in query.split('&') if '=' in p)
            # kind 1: the base plane (the game as gamescope has it, often at the size of the game); kind 2: the whole screen as it is shown (always the size of the screen)
            data = clean_shot(kind='2' if q.get('kind') == '2' else '1')
            if data is None:
                return self._send(204)
            return self._send(200, data, 'image/png', headers={'X-Age-Ms': int(1000 * (time.time() - t0))})
        if path == '/save':
            with cond:
                data, seq = state['frame'], state['seq']
            name = DEBUG_FRAME
            open(name, 'wb').write(data)
            return self._send(200, json.dumps({'file': name, 'bytes': len(data), 'seq': seq}).encode(), 'application/json')
        if path.startswith('/assets/'):
            root = os.path.realpath(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets'))
            target = os.path.realpath(os.path.join(root, path[len('/assets/'):]))
            if not target.startswith(root + os.sep) or not os.path.isfile(target):
                return self._send(404)
            kinds = {'.js': 'application/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'}
            return self._send(200, open(target, 'rb').read(), kinds.get(os.path.splitext(target)[1], 'application/octet-stream'))
        if path == '/record/start':
            q = dict(p.split('=') for p in query.split('&') if '=' in p)
            folder = record_start(min(60, max(2, int(q.get('seconds', '10')))))
            return self._send(200, json.dumps({'dir': folder, 'until': record['until']}).encode(), 'application/json')
        if path == '/record/size':
            return self._send(200, json.dumps({'bytes': dir_bytes(RECORD_ROOT), 'count': count_recordings(RECORD_ROOT)}).encode(), 'application/json')
        if path == '/record/clear':
            record_clear()
            return self._send(200, json.dumps({'bytes': dir_bytes(RECORD_ROOT)}).encode(), 'application/json')
        if path == '/record/status':
            return self._send(200, json.dumps({'dir': record['dir'], 'running': bool(record['dir']) and time.time() < record['until'], 'frames': record['n'], 'saved': record['saved']}).encode(), 'application/json')
        if path.startswith('/models/'):
            # The models of the local translator (downloaded by the plugin into its data folder)
            root = os.path.realpath(os.environ.get('DLT_MODELS', ''))
            target = os.path.realpath(os.path.join(root, path[len('/models/'):]))
            if not os.environ.get('DLT_MODELS') or not target.startswith(root + os.sep) or not os.path.isfile(target):
                return self._send(404)
            with open(target, 'rb') as f:
                return self._send(200, f.read())
        if path == '/quit':
            self._send(200, b'bye')
            GLib.idle_add(shutdown)
            return
        self._send(404)


def serve():
    # what an earlier run left behind (old recordings, debug frames, a big log of the layer) goes at the start
    try:
        record_prune()
    except Exception:
        pass
    cleanup_leftovers()
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()


signal.signal(signal.SIGTERM, lambda *_: GLib.idle_add(shutdown))
signal.signal(signal.SIGINT, lambda *_: GLib.idle_add(shutdown))
threading.Thread(target=serve, daemon=True).start()
threading.Thread(target=record_writer, daemon=True).start()
threading.Thread(target=scaler_watch, daemon=True).start()
if not os.environ.get('DLT_NO_PIPEWIRE'):      # (tests: only the frames of the layer)
    GLib.idle_add(lambda: (build(), False)[1])
layer_enable()
GLib.timeout_add(2000, layer_enable)
GLib.timeout_add(int(1000 / FPS), tick)
loop.run()
