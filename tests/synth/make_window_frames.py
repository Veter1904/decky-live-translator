"""Draws a window of a story game (a title, long paragraphs, choices) on a clean frame of a game, at several scroll positions, and writes what is where (the truth).
    python tests/synth/make_window_frames.py <base frame.png> <out dir>
The frames and truth are used by tests/harness/windowtest.ts (open, read, scroll, close, open again: what stays, what appears, what is missing)."""
import json
import os
import sys
import textwrap

from PIL import Image, ImageDraw, ImageFont

base_path, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
W, H = 1920, 1080
PANEL = (420, 150, 1500, 930)         # x0, y0, x1, y1
PAD = 46
SIZE = 30
LEADING = 38
STEP = 30                              # pixels of one scroll step
STEPS = 11


def font(name_options, size):
    for name in name_options:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


body_font = font(['georgia.ttf', 'times.ttf', 'DejaVuSerif.ttf'], SIZE)
title_font = font(['georgiab.ttf', 'timesbd.ttf', 'DejaVuSerif-Bold.ttf'], 38)
choice_font = font(['georgia.ttf', 'times.ttf', 'DejaVuSerif.ttf'], 28)

TITLE = 'Blue Kingdom Transit Relay'
PARAGRAPHS = [
    "The Relay's lamps gutter as you bring the locomotive alongside. Somewhere below, a pump coughs and settles, and the whole platform shivers like a sleeper disturbed. A clerk in a mouldering greatcoat peers at you over a ledger, unwilling to be impressed.",
    "\"Name of vessel?\" he asks. \"Cargo? Purpose? The Blue Kingdom does not hold with idle visitors, and the lamplighters are particular about the dark.\" Behind him a door stands ajar, and through it you glimpse shelves of letters that nobody has called for in years.",
    "You could answer plainly. You could lie, and trust that the ledger is as tired as its keeper. Or you could simply wait, as the Reach teaches all travellers to do, and see what the silence offers you first.",
    "Your crew shifts behind you. The engine ticks as it cools, and a thin rain begins to fall through the broken glass of the roof, ringing against the rails one drop at a time.",
    "At the far end of the platform a woman in a feathered hat is arguing with a porter about a trunk that will not fit through the gate. Neither of them looks up. Neither of them, you suspect, has looked up in some time.",
    "The clerk taps his pen against the ledger, a slow patient sound, the sound of a man who has outlasted better visitors than you.",
]
CHOICES = [
    "Give your name and your purpose honestly.",
    "Claim to be carrying mail for the Relay.",
    "Say nothing, and let him fill the silence.",
]

base = Image.open(base_path).convert('RGB').resize((W, H))
panel_w = PANEL[2] - PANEL[0] - 2 * PAD
chars = max(20, int(panel_w / (SIZE * 0.47)))


def wrap(text):
    return textwrap.wrap(text, width=chars)


# the content as a list of (kind, paragraph index, text lines) with y positions relative to the top of the scrolling area
content = []
y = 0
for index, paragraph in enumerate(PARAGRAPHS):
    lines = wrap(paragraph)
    content.append({'kind': 'paragraph', 'id': index, 'lines': lines, 'y': y})
    y += len(lines) * LEADING + 28
for index, choice in enumerate(CHOICES):
    content.append({'kind': 'choice', 'id': index, 'lines': [choice], 'y': y})
    y += 70
CONTENT_H = y
AREA = (PANEL[0] + PAD, PANEL[1] + 110, PANEL[2] - PAD, PANEL[3] - 40)    # where the text scrolls
AREA_H = AREA[3] - AREA[1]


def draw(offset):
    image = base.copy()
    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    d.rounded_rectangle(PANEL, radius=10, fill=(8, 8, 12, 214), outline=(120, 110, 90, 255), width=2)
    d.text((PANEL[0] + PAD, PANEL[1] + 34), TITLE, font=title_font, fill=(236, 222, 190, 255))
    d.line((PANEL[0] + PAD, PANEL[1] + 94, PANEL[2] - PAD, PANEL[1] + 94), fill=(120, 110, 90, 255), width=2)
    image = Image.alpha_composite(image.convert('RGBA'), overlay)
    # the scrolling text is drawn on its own layer and cut by the edges of the area
    layer = Image.new('RGBA', (AREA[2] - AREA[0], AREA_H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    truth = []
    for block in content:
        top = block['y'] - offset
        if block['kind'] == 'paragraph':
            for i, line in enumerate(block['lines']):
                ld.text((0, top + i * LEADING), line, font=body_font, fill=(226, 218, 200, 255))
            height = len(block['lines']) * LEADING
        else:
            ld.rounded_rectangle((0, top - 8, AREA[2] - AREA[0], top + 50), radius=6, outline=(150, 130, 90, 255), width=2, fill=(30, 26, 22, 230))
            ld.text((24, top + 2), block['lines'][0], font=choice_font, fill=(240, 226, 170, 255))
            height = 50
        # the block is on the truth when it is whole inside the area (a block that an edge cuts is not asked for)
        if top >= 0 and top + height <= AREA_H:
            truth.append({'kind': block['kind'], 'id': block['id'], 'text': ' '.join(block['lines']), 'y0': AREA[1] + top, 'y1': AREA[1] + top + height})
    image.alpha_composite(layer, dest=(AREA[0], AREA[1]))
    return image.convert('RGB'), truth


image, truth = Image.open(base_path).convert('RGB').resize((W, H)), []
base.save(os.path.join(out, 'base.png'))
json.dump([], open(os.path.join(out, 'base.json'), 'w'))
max_offset = max(0, CONTENT_H - AREA_H)
steps = min(STEPS, max(1, int(max_offset / STEP) + 1))
offsets = [min(max_offset, i * STEP) for i in range(steps)]
for index, offset in enumerate(offsets):
    image, truth = draw(offset)
    image.save(os.path.join(out, 'w%02d.png' % index))
    json.dump({'offset': offset, 'truth': truth}, open(os.path.join(out, 'w%02d.json' % index), 'w'), ensure_ascii=False)
json.dump({'frames': len(offsets), 'offsets': offsets, 'content_h': CONTENT_H, 'area_h': AREA_H}, open(os.path.join(out, 'info.json'), 'w'))
print('frames', len(offsets), 'content', CONTENT_H, 'area', AREA_H, 'offsets', offsets, file=sys.stderr)
