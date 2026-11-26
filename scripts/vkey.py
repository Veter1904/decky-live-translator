"""A virtual keyboard (uinput) for tests on the Deck: sends key presses to whatever has the focus, like a real keyboard. Run it ON the Deck:
    python3 vkey.py ENTER 1.5 DOWN DOWN ESC      (a name presses a key, NAME=2 holds it for 2 s, a number waits that many seconds)
The user must be able to write /dev/uinput (the Deck's user can)."""
import fcntl
import os
import struct
import sys
import time

KEYS = {'ESC': 1, 'ENTER': 28, 'SPACE': 57, 'UP': 103, 'LEFT': 105, 'RIGHT': 106, 'DOWN': 108, 'PAGEUP': 104, 'PAGEDOWN': 109, 'TAB': 15,
        'J': 36, 'I': 23, 'M': 50, 'C': 46, 'F8': 66}
for row, start in (('QWERTYUIOP', 16), ('ASDFGHJKL', 30), ('ZXCVBNM', 44)):
    for offset, letter in enumerate(row):
        KEYS.setdefault(letter, start + offset)

UI_SET_EVBIT, UI_SET_KEYBIT, UI_DEV_SETUP, UI_DEV_CREATE, UI_DEV_DESTROY = 0x40045564, 0x40045565, 0x405c5503, 0x5501, 0x5502
EV_SYN, EV_KEY = 0, 1

fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
for code in set(KEYS.values()):
    fcntl.ioctl(fd, UI_SET_KEYBIT, code)
fcntl.ioctl(fd, UI_DEV_SETUP, struct.pack('HHHH80sI', 0x03, 0x1234, 0x5678, 1, b'dlt-test-keyboard', 0))
fcntl.ioctl(fd, UI_DEV_CREATE)
time.sleep(1.5)


def emit(kind, code, value):
    now = time.time()
    os.write(fd, struct.pack('llHHi', int(now), int((now % 1) * 1e6), kind, code, value))


def press(code):
    emit(EV_KEY, code, 1)
    emit(EV_SYN, 0, 0)
    time.sleep(0.08)
    emit(EV_KEY, code, 0)
    emit(EV_SYN, 0, 0)


for item in sys.argv[1:]:
    if '=' in item and item.split('=')[0].upper() in KEYS:
        # KEY=seconds: the key is held
        code = KEYS[item.split('=')[0].upper()]
        emit(EV_KEY, code, 1)
        emit(EV_SYN, 0, 0)
        time.sleep(float(item.split('=')[1]))
        emit(EV_KEY, code, 0)
        emit(EV_SYN, 0, 0)
        time.sleep(0.35)
    elif item.upper() in KEYS:
        press(KEYS[item.upper()])
        time.sleep(0.35)
    else:
        time.sleep(float(item))
time.sleep(0.5)
fcntl.ioctl(fd, UI_DEV_DESTROY)
os.close(fd)
