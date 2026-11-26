"""Tests that what the plugin keeps on the card stays small: the memory of translations (a limit of files and bytes, clearing that spares a hand-written glossary), the usage report,
the recordings, and the removal of files that a write leaves behind. The Decky module is stubbed (the backend runs on the Deck, this on any machine)."""
import asyncio
import json
import os
import sys
import tempfile
import time
import types

root = tempfile.mkdtemp()
home = os.path.join(root, 'home')
os.makedirs(home)
settings = os.path.join(root, 'settings')
decky = types.ModuleType('decky')
for name, value in dict(DECKY_PLUGIN_DIR=os.path.abspath(os.path.join(os.path.dirname(__file__), '..')), DECKY_PLUGIN_SETTINGS_DIR=settings, DECKY_PLUGIN_RUNTIME_DIR=root,
                        DECKY_PLUGIN_LOG_DIR=root, DECKY_USER_HOME=home, DECKY_USER='nobody').items():
    setattr(decky, name, value)
decky.logger = types.SimpleNamespace(error=print, info=print, warning=print)
sys.modules['decky'] = decky
sys.modules.setdefault('pwd', types.ModuleType('pwd'))
sys.path.insert(0, decky.DECKY_PLUGIN_DIR)
import main  # noqa: E402

plugin = main.Plugin()
bad = 0


def check(label, ok):
    global bad
    print(('ok   ' if ok else 'FAIL ') + label)
    bad += 0 if ok else 1


async def run():
    # too many games: the least lately used files go, the one that was written stays
    main.MEMORY_MAX_FILES = 5
    for i in range(8):
        await plugin.memory_put(str(1000 + i), 'G%d' % i, {'en>uk|a': {'t': 'б', 'n': 1, 'at': 1}})
        time.sleep(0.02)
    files = sorted(os.listdir(os.path.join(settings, 'memory')))
    check('at most %d games are kept' % main.MEMORY_MAX_FILES, len(files) == 5)
    check('the game that was written last is kept', '1007.json' in files)
    check('the oldest games went', '1000.json' not in files and '1001.json' not in files)
    # too many bytes
    main.MEMORY_MAX_FILES = 40
    main.MEMORY_MAX_BYTES = 5000
    big = {'en>uk|text %d' % i: {'t': 'переклад ' * 5, 'n': 1, 'at': 1} for i in range(60)}
    await plugin.memory_put('2000', 'Big', big)
    await plugin.memory_put('2001', 'Big2', big)
    total = sum(os.path.getsize(os.path.join(settings, 'memory', f)) for f in os.listdir(os.path.join(settings, 'memory')))
    check('the games together may not take more than the limit (the one written last may be alone over it)', os.path.exists(os.path.join(settings, 'memory', '2001.json')) and total < 3 * 6000)
    # a leftover of an interrupted write is removed
    leftover = os.path.join(settings, 'memory', '55.json.tmp')
    open(leftover, 'w').write('{')
    main.MEMORY_MAX_BYTES = 40 * 1000 * 1000
    await plugin.memory_put('3000', 'X', {})
    check('a leftover .tmp file is removed', not os.path.exists(leftover))
    # the usage report
    usage = await plugin.data_usage()
    check('usage counts the games and the bytes', usage['memory_games'] >= 1 and usage['memory_bytes'] > 0 and usage['records_bytes'] == 0)
    records = os.path.join(home, 'dlt-records', '20261125-000000')
    os.makedirs(records)
    open(os.path.join(records, 'f000.raw.z'), 'wb').write(b'x' * 1234)
    usage = await plugin.data_usage()
    check('usage counts the recordings', usage['records_bytes'] == 1234 and usage['records_count'] == 1)
    await plugin.clear_records()
    check('the recordings are cleared', (await plugin.data_usage())['records_bytes'] == 0)
    # clearing the memory spares a glossary that the player wrote
    path = plugin._memory_path('3000')
    data = json.load(open(path, encoding='utf-8'))
    data['glossary'] = {'Scroll': 'Прокрутити'}
    data['entries'] = {'en>uk|a': {'t': 'б', 'n': 1, 'at': 1}}
    json.dump(data, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    await plugin.clear_memory()
    left = await plugin.memory_get('3000')
    check('the glossary stays when the memory is cleared, the texts go', left['glossary'] == {'Scroll': 'Прокрутити'} and left['entries'] == {})
    check('a game without a glossary has no file after clearing', not os.path.exists(plugin._memory_path('2000')))


asyncio.run(run())
sys.exit(bad)
