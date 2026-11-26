"""Tests the settings of the backend: a first start (private defaults, the "fresh" flag), and the migration of an install made before the languages of the interface
(it keeps the Ukrainian interface and the translator it used). The Decky module is stubbed."""
import asyncio
import json
import os
import sys
import tempfile
import types

root = tempfile.mkdtemp()
decky = types.ModuleType('decky')
for name, value in dict(DECKY_PLUGIN_DIR=os.path.abspath(os.path.join(os.path.dirname(__file__), '..')), DECKY_PLUGIN_SETTINGS_DIR=root, DECKY_PLUGIN_RUNTIME_DIR=root,
                        DECKY_PLUGIN_LOG_DIR=root, DECKY_USER_HOME=root, DECKY_USER='nobody').items():
    setattr(decky, name, value)
decky.logger = types.SimpleNamespace(error=print, info=print, warning=print)
sys.modules['decky'] = decky
sys.modules.setdefault('pwd', types.ModuleType('pwd'))
sys.path.insert(0, decky.DECKY_PLUGIN_DIR)
import main  # noqa: E402

plugin = main.Plugin()
path = os.path.join(root, 'settings.json')
bad = 0


def check(label, ok):
    global bad
    print(('ok   ' if ok else 'FAIL ') + label)
    bad += 0 if ok else 1


def write(data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f)


async def run():
    # a first start
    if os.path.exists(path):
        os.remove(path)
    first = await plugin.get_settings()
    check('a first start is marked fresh', first.get('fresh') is True)
    check('a new install translates on the device only', first['translator'] == 'local')
    check('the interface follows Steam by default', first['ui_language'] == 'auto')
    await plugin.set_settings({'target': 'de', 'source': 'en'})
    again = await plugin.get_settings()
    check('after the first settings are saved it is no longer fresh', 'fresh' not in again and again['target'] == 'de')
    check('"fresh" is never written to the file', 'fresh' not in json.load(open(path, encoding='utf-8')))

    # an install of version 6 (before the languages): it keeps Ukrainian and its translator
    write({'enabled': True, 'source': 'en', 'target': 'uk', 'profile': 'auto', 'debug': False, 'layer': True, 'translator': 'smart', 'reader': 'modern', 'version': 6})
    old = await plugin.get_settings()
    check('an older install keeps the Ukrainian interface', old['ui_language'] == 'uk' and old['version'] == 7)
    check('an older install keeps its translator', old['translator'] == 'smart' and old['enabled'] is True)
    check('the migration is written to the file', json.load(open(path, encoding='utf-8'))['ui_language'] == 'uk')
    check('an older install is not "fresh"', 'fresh' not in old)

    write({'enabled': False, 'source': 'en', 'target': 'uk', 'translator': 'online', 'version': 6})
    check('an "online" choice is kept', (await plugin.get_settings())['translator'] == 'online')
    write({'enabled': False, 'source': 'en', 'target': 'uk', 'version': 6})
    check('an old file without a translator keeps the old default (smart)', (await plugin.get_settings())['translator'] == 'smart')

    # a language that the player chose is kept
    write({'enabled': False, 'source': 'en', 'target': 'uk', 'translator': 'local', 'ui_language': 'de', 'version': 7})
    check('a chosen language is kept', (await plugin.get_settings())['ui_language'] == 'de')


asyncio.run(run())
sys.exit(bad)
