"""Fetches the latest recording of the Deck (made with the panel button "Записати 10 с для розробника") and turns its frames into PNG files.

usage: python scripts/pull_record.py <ssh key> [out dir] [time part]      (the Deck is DECK_HOST, e.g. deck@steamdeck.local)
Gives: <out>/<time>/f000.png ..., index.jsonl (what each frame was), plates.jsonl (what the translator showed, once per second).
"""
import json, os, subprocess, sys, zlib
import numpy as np
from PIL import Image

key = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join('tests', 'records')
host = os.environ.get('DECK_HOST', 'deck@steamdeck.local')
ssh = ['ssh', '-i', key, host]
latest = subprocess.check_output(ssh + ['ls -1d ~/dlt-records/*%s | tail -1' % (sys.argv[3] if len(sys.argv) > 3 else '')]).decode().strip()
name = os.path.basename(latest)
dest = os.path.join(out, name)
os.makedirs(dest, exist_ok=True)
subprocess.check_call(['scp', '-i', key, '-q', '-r', host + ':' + latest + '/.', dest])
index = [json.loads(line) for line in open(os.path.join(dest, 'index.jsonl')) if line.strip()]
for meta in index:
    raw = zlib.decompress(open(os.path.join(dest, 'f%03d.raw.z' % meta['n']), 'rb').read())
    a = np.frombuffer(raw, dtype=np.uint8).reshape(meta['h'], meta['w'], 4)
    rgb = a[:, :, [2, 1, 0]] if meta['fmt'] in ('BGRx', 'BGRA') else a[:, :, :3]
    Image.fromarray(rgb).save(os.path.join(dest, 'f%03d.png' % meta['n']))
    os.remove(os.path.join(dest, 'f%03d.raw.z' % meta['n']))
print(dest, len(index), 'frames')
