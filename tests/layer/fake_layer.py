# writes frames in the format of the Vulkan layer (to test the helper without a game)
import mmap, os, struct, sys, time
d = '/dev/shm/dlt-%d' % os.getuid(); os.makedirs(d, exist_ok=True)
w, h, fmt = 1280, 720, 44   # B8G8R8A8_UNORM
path = os.path.join(d, 'frame')
size = 4096 + w * h * 4
with open(path, 'w+b') as f: f.truncate(size); mm = mmap.mmap(f.fileno(), size)
seq = 0
for i in range(int(sys.argv[1]) if len(sys.argv) > 1 else 30):
    seq += 1; struct.pack_into('<Q', mm, 8, seq * 2 - 1)           # odd: writing
    px = bytes([(i * 8) % 256, 128, 255 - (i * 8) % 256, 255]) * (w * h)   # B,G,R,A
    mm[4096:4096 + w * h * 4] = px
    struct.pack_into('<IIQIIIIQII', mm, 0, 0x46544c44, 1, seq * 2, w, h, fmt, w * 4, time.time_ns(), os.getpid(), 4242)
    time.sleep(0.25)
