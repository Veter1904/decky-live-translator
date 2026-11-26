// A line that is not English (the plate of the plugin, Cyrillic read as Latin letters and digits) is recognised; real lines of games are not taken for it.
import { setWordList } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ppocr'
import { looksLikeForeignScript } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/engine'
const fs = require('fs')
setWordList(fs.readFileSync('E:/decky-live-translator/assets/ocr/words-en.txt', 'utf8'))
let bad = 0
const check = (label: string, got: boolean, expected: boolean) => { const ok = got === expected; console.log((ok ? 'ok   ' : 'FAIL ') + label + ': ' + JSON.stringify(got)); if (!ok) bad++ }
// the readings of Ukrainian plates (from recordings made on the Deck)
for (const text of ['Bawa no3nuin! Lle noka3ye BAL', 'Ha3an Bn6pain', '18 6epe3H9 1905 poky', '4N iHWNM 4WHOM).']) check('junk: ' + text, looksLikeForeignScript(text), text !== '4N iHWNM 4WHOM).')
// real text of games, with numbers
for (const text of ['Your Hold! This shows your current cargo', 'Press A to continue', 'H2O is water', 'Level 5B2 reached', '17th Mar 1905', 'You have 3 Supplies (new total 5).', 'The Wreck of the Ozymandias', 'REPORT A BUG (F8)', 'Ozymandias Orphean Veils']) check('game text: ' + text, looksLikeForeignScript(text), false)
process.exit(bad)
