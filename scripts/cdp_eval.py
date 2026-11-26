"""Runs a piece of JavaScript (from stdin) in a page of the Steam UI through the Chromium debugging port (127.0.0.1:8080), for tests.
Run it ON the Deck:  python3 cdp_eval.py SharedJSContext < script.js        (the script is an expression or async function body result: awaited)
Prints the result as JSON. Standard library only (a minimal websocket client)."""
import base64, json, os, socket, struct, sys, urllib.request

title = sys.argv[1] if len(sys.argv) > 1 else 'SharedJSContext'
timeout = float(sys.argv[2]) if len(sys.argv) > 2 else 120
targets = json.load(urllib.request.urlopen('http://127.0.0.1:8080/json'))
target = next(t for t in targets if title in t['title'])
sock = socket.create_connection(('127.0.0.1', 8080), timeout=timeout)
key = base64.b64encode(os.urandom(16)).decode()
path = target['webSocketDebuggerUrl'].split('8080', 1)[1]
sock.sendall(('GET %s HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (path, key)).encode())
buf = b''
while b'\r\n\r\n' not in buf:
    buf += sock.recv(4096)
buf = buf.split(b'\r\n\r\n', 1)[1]


def send(text):
    data = text.encode()
    head = bytearray([0x81])
    n = len(data)
    if n < 126:
        head.append(0x80 | n)
    elif n < 65536:
        head += bytes([0x80 | 126]) + struct.pack('>H', n)
    else:
        head += bytes([0x80 | 127]) + struct.pack('>Q', n)
    mask = os.urandom(4)
    sock.sendall(bytes(head) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def need(n):
    global buf
    while len(buf) < n:
        chunk = sock.recv(1 << 16)
        if not chunk:
            raise EOFError
        buf += chunk
    out, buf = buf[:n], buf[n:]
    return out


def receive():
    message = b''
    while True:
        b0, b1 = need(2)
        n = b1 & 0x7f
        if n == 126:
            n = struct.unpack('>H', need(2))[0]
        elif n == 127:
            n = struct.unpack('>Q', need(8))[0]
        message += need(n)
        if b0 & 0x80:
            return message.decode('utf-8', 'replace')


code = sys.stdin.read()
send(json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': '(async () => {' + code + '})()', 'awaitPromise': True, 'returnByValue': True}}))
while True:
    answer = json.loads(receive())
    if answer.get('id') == 1:
        print(json.dumps(answer.get('result'), ensure_ascii=False, indent=1)[:6000])
        break
