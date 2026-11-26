"""What the capture helper keeps on the card and in the memory, and how it is kept small: the recordings made for the developer, and the leftovers of the helper.
Kept apart from the helper (which starts threads and a main loop when it is imported) so that it can be tested."""
import os
import shutil
import time

# How many recordings made for the developer are kept, how many bytes they may take together, and how many days old they may get. A recording is 10-50 MB; the player makes several in a row
# when something is wrong, and they must still be there when they are looked at: a count that is too small removes them unseen.
RECORD_KEEP = 12
RECORD_MAX_BYTES = 400 * 1000 * 1000
RECORD_MAX_AGE_DAYS = 7


def dir_bytes(path):
    total = 0
    for base, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return total


def prune_recordings(root, keep, max_bytes, max_age_days, now=None):
    """Removes the recordings (folders named by their time) that are too many, too big together or too old; the newest are kept. Returns how many bytes are left."""
    now = time.time() if now is None else now
    try:
        names = sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
    except OSError:
        return 0
    kept = []
    for d in names:
        path = os.path.join(root, d)
        try:
            age_days = (now - os.path.getmtime(path)) / 86400
        except OSError:
            continue
        if age_days > max_age_days:
            shutil.rmtree(path, ignore_errors=True)
        else:
            kept.append(d)
    keep = max(0, keep)
    for d in kept[:len(kept) - keep]:
        shutil.rmtree(os.path.join(root, d), ignore_errors=True)
    kept = kept[len(kept) - keep:] if keep > 0 else []
    sizes = {d: dir_bytes(os.path.join(root, d)) for d in kept}
    while len(kept) > 1 and sum(sizes.values()) > max_bytes:
        d = kept.pop(0)
        shutil.rmtree(os.path.join(root, d), ignore_errors=True)
        sizes.pop(d, None)
    return sum(sizes.values())


def clear_recordings(root, active=None):
    """All recordings are removed (not the one that is being made)."""
    try:
        for d in os.listdir(root):
            path = os.path.join(root, d)
            if os.path.isdir(path) and path != active:
                shutil.rmtree(path, ignore_errors=True)
    except OSError:
        pass


def count_recordings(root):
    try:
        return len([d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))])
    except OSError:
        return 0


def remove_files(names):
    for name in names:
        try:
            os.remove(name)
        except OSError:
            pass


def truncate_if_big(path, limit):
    """A log that has grown past `limit` bytes is emptied."""
    try:
        if os.path.getsize(path) > limit:
            open(path, 'w').close()
    except OSError:
        pass


def folder_usage(folder):
    """(bytes, files) of the files in a folder (not its sub-folders)."""
    total = 0
    count = 0
    try:
        for name in os.listdir(folder):
            path = os.path.join(folder, name)
            if os.path.isfile(path):
                total += os.path.getsize(path)
                count += 1
    except OSError:
        pass
    return total, count


def prune_files(folder, max_files, max_bytes, keep=None):
    """The files of a folder that are too many or take too much together are removed, the least lately changed first; `keep` is never removed. Leftover *.tmp files go at once."""
    try:
        names = os.listdir(folder)
    except OSError:
        return
    files = []
    for name in names:
        path = os.path.join(folder, name)
        if not os.path.isfile(path):
            continue
        if name.endswith('.tmp') and path != keep:
            remove_files([path])
            continue
        try:
            files.append((os.path.getmtime(path), os.path.getsize(path), path))
        except OSError:
            pass
    files.sort(reverse=True)
    total = 0
    for index, (_mtime, size, path) in enumerate(files):
        total += size
        if path != keep and (index >= max_files or total > max_bytes):
            remove_files([path])
            total -= size
