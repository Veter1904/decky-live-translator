"""Tests the memory of translations of the backend (main.py) with a stub of the Decky module (the backend runs on the Deck, this on any machine)."""
import asyncio, json, os, sys, tempfile, types

root = tempfile.mkdtemp()
decky = types.ModuleType('decky')
for name, value in dict(DECKY_PLUGIN_DIR=os.path.join(os.path.dirname(__file__), '..'), DECKY_PLUGIN_SETTINGS_DIR=root, DECKY_PLUGIN_RUNTIME_DIR=root, DECKY_PLUGIN_LOG_DIR=root,
                        DECKY_USER_HOME=root, DECKY_USER='nobody').items():
    setattr(decky, name, value)
decky.logger = types.SimpleNamespace(error=print, info=print, warning=print)
sys.modules['decky'] = decky
sys.modules.setdefault('pwd', types.ModuleType('pwd'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import main  # noqa: E402

plugin = main.Plugin()
bad = 0


def check(label, ok):
    global bad
    print(('ok   ' if ok else 'FAIL ') + label)
    bad += 0 if ok else 1


async def run():
    check('nothing kept yet', (await plugin.memory_get('1234')) == {'name': '', 'entries': {}, 'glossary': {}})
    entries = {'en>uk|Back to list': {'t': 'Назад до списку', 'n': 3, 'at': 1}}
    check('written', await plugin.memory_put('1234', 'Sunless Skies', entries) is True)
    got = await plugin.memory_get('1234')
    check('read back', got['name'] == 'Sunless Skies' and got['entries'] == entries and got['glossary'] == {})
    # the player edits the glossary by hand; a later write must not lose it
    path = plugin._memory_path('1234')
    data = json.load(open(path, encoding='utf-8'))
    data['glossary'] = {'Scroll': 'Прокрутити'}
    json.dump(data, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    entries['en>uk|Close'] = {'t': 'Закрити', 'n': 1, 'at': 2}
    await plugin.memory_put('1234', 'Sunless Skies', entries)
    got = await plugin.memory_get('1234')
    check('the glossary survives a write', got['glossary'] == {'Scroll': 'Прокрутити'} and len(got['entries']) == 2)
    # games are kept apart, and an odd id cannot leave the folder
    await plugin.memory_put('99', 'Other', {'en>uk|Back to list': {'t': 'Назад', 'n': 1, 'at': 1}})
    check('another game has its own file', (await plugin.memory_get('99'))['entries']['en>uk|Back to list']['t'] == 'Назад' and (await plugin.memory_get('1234'))['entries']['en>uk|Back to list']['t'] == 'Назад до списку')
    odd = plugin._memory_path('../../etc/passwd')
    check('an odd id stays inside the folder', os.path.dirname(odd) == os.path.join(root, 'memory'))
    # a broken file is not a crash
    open(plugin._memory_path('7'), 'w').write('{not json')
    check('a broken file reads as empty', (await plugin.memory_get('7'))['entries'] == {})

asyncio.run(run())
sys.exit(bad)
