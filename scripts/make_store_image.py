"""Makes docs/store-image.png: the picture of the plugin for the Decky store (1280x720). It is drawn, not a screenshot of a game (no game is shown).
Run:  python scripts/make_store_image.py     (needs Pillow; uses the fonts of the system)"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def font(size, bold=False):
    names = ['segoeuib.ttf', 'arialbd.ttf', 'DejaVuSans-Bold.ttf'] if bold else ['segoeui.ttf', 'arial.ttf', 'DejaVuSans.ttf']
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


# background: a dark gradient with a soft glow (the colours of a game menu)
image = Image.new('RGB', (W, H))
pixels = image.load()
for y in range(H):
    for x in range(W):
        t = y / H
        glow = max(0.0, 1.0 - (((x - 940) / 520.0) ** 2 + ((y - 260) / 360.0) ** 2))
        pixels[x, y] = (int(14 + 10 * t + 26 * glow), int(18 + 12 * t + 46 * glow), int(34 + 20 * t + 92 * glow))
draw = ImageDraw.Draw(image, 'RGBA')

# the title
draw.text((72, 78), 'Live Translator', font=font(88, True), fill=(240, 244, 255))
draw.text((76, 188), 'Automatic translation of any game\'s text', font=font(36), fill=(170, 186, 220))
draw.text((76, 236), 'on your Steam Deck, as you play', font=font(36), fill=(170, 186, 220))

# the points
points = ['Reads the game\'s own frames', 'Translates on the device: works offline', '13 UI languages, 57 target languages', 'Plates follow scrolling text']
for index, text in enumerate(points):
    y = 350 + index * 62
    draw.ellipse((78, y + 12, 98, y + 32), fill=(96, 200, 140))
    draw.text((118, y), text, font=font(34), fill=(226, 232, 248))


def plate(x, y, original, translated, colour, text_colour):
    """A game's menu item (the original) with the translation plate on it."""
    box = (x, y, x + 400, y + 64)
    draw.rounded_rectangle(box, radius=10, fill=(38, 44, 66, 255), outline=(76, 88, 128, 255), width=2)
    draw.text((x + 22, y + 15), original, font=font(30), fill=(150, 160, 190))
    draw.rounded_rectangle((x + 4, y + 4, x + 396, y + 60), radius=8, fill=colour)
    draw.text((x + 22, y + 15), translated, font=font(30, True), fill=text_colour)


# a menu with some items translated: the plates take the colours of the letters
x0 = 800
draw.rounded_rectangle((x0 - 40, 330, x0 + 440, 650), radius=18, fill=(8, 10, 20, 150))
plate(x0, 352, 'Continue', 'Продовжити', (62, 90, 70, 255), (230, 255, 236))
plate(x0, 432, 'Options', 'Налаштування', (44, 52, 80, 255), (226, 232, 248))
plate(x0, 512, 'Quit game', 'Вийти з гри', (88, 52, 56, 255), (255, 232, 232))

out = os.path.join(root, 'docs', 'store-image.png')
os.makedirs(os.path.dirname(out), exist_ok=True)
image.save(out, optimize=True)
print(out, os.path.getsize(out), 'bytes', file=sys.stderr)
