"""Tests the retention of the recordings and the cleaning of leftovers (bin/dlt_retention.py)."""
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'bin'))
import dlt_retention as r  # noqa: E402

bad = 0


def check(label, ok):
    global bad
    print(('ok   ' if ok else 'FAIL ') + label)
    bad += 0 if ok else 1


root = tempfile.mkdtemp()


def make(name, size, age_days=0):
    path = os.path.join(root, name)
    os.makedirs(path)
    open(os.path.join(path, 'f000.raw.z'), 'wb').write(b'x' * size)
    t = time.time() - age_days * 86400
    os.utime(path, (t, t))


def names():
    return sorted(os.listdir(root))


MB = 1000 * 1000

for i in range(5):
    make('2026112%d-000000' % i, 1000)
r.prune_recordings(root, 2, 100 * MB, 7)
check('only the newest two are kept', names() == ['20261123-000000', '20261124-000000'])
r.prune_recordings(root, 1, 100 * MB, 7)
check('room for a new one: one is kept', names() == ['20261124-000000'])
make('20261125-000000', 10, age_days=9)
r.prune_recordings(root, 5, 100 * MB, 7)
check('a recording older than a week goes', '20261125-000000' not in names() and '20261124-000000' in names())
for n in names():
    shutil.rmtree(os.path.join(root, n))
make('a', 70 * MB)
make('b', 70 * MB)
left = r.prune_recordings(root, 2, 100 * MB, 7)
check('too big together: the older goes, the newest stays', names() == ['b'] and left == 70 * MB)
make('c', 5)
check('count', r.count_recordings(root) == 2)
r.clear_recordings(root, active=os.path.join(root, 'c'))
check('clear keeps the one that is being made', names() == ['c'])
r.clear_recordings(root)
check('clear removes all', names() == [] and r.dir_bytes(root) == 0)
check('a root that is not there is not an error', r.prune_recordings(os.path.join(root, 'nope'), 2, MB, 7) == 0)
log = os.path.join(root, 'layer.log')
open(log, 'w').write('x' * 300000)
r.truncate_if_big(log, 200000)
check('a big log is emptied', os.path.getsize(log) == 0)
open(log, 'w').write('x' * 100)
r.truncate_if_big(log, 200000)
check('a small log is left', os.path.getsize(log) == 100)
f = os.path.join(root, 'dbg')
open(f, 'w').write('1')
r.remove_files([f, os.path.join(root, 'missing')])
check('leftover files are removed, a missing one is not an error', not os.path.exists(f))
sys.exit(bad)
