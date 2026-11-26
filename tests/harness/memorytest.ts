// The memory of translations (src/memory.ts): the logic that does not need the Deck.
import { TranslationMemory, memoryKey } from '../../src/memory'
let bad = 0
const check = (label: string, ok: boolean) => { console.log((ok ? 'ok   ' : 'FAIL ') + label); if (!ok) bad++ }
const m = new TranslationMemory()
m.put('en', 'uk', 'Hello', 'Привіт')
check('nothing is kept without a game', m.get('en', 'uk', 'Hello') === null)
m.load('1234', 'Game', { entries: { [memoryKey('en', 'uk', 'Back to list')]: { t: 'Назад до списку', n: 1, at: Date.now() } }, glossary: { Scroll: 'Прокрутити' } })
check('a kept text is found', m.get('en', 'uk', 'Back to list') === 'Назад до списку')
check('white space does not matter', m.get('en', 'uk', '  Back   to list ') === 'Назад до списку')
check('another language pair is another text', m.get('en', 'de', 'Back to list') === null)
check('the glossary wins', m.get('en', 'uk', 'Scroll') === 'Прокрутити')
m.put('en', 'uk', 'Scroll', 'Згорток')
check('the glossary is not overwritten', m.get('en', 'uk', 'Scroll') === 'Прокрутити')
m.dirty = false
m.put('en', 'uk', 'Close', 'Закрити')
check('a new text is kept and marks the memory for saving', m.get('en', 'uk', 'Close') === 'Закрити' && m.dirty)
m.dirty = false
m.put('en', 'uk', 'Close', 'Закрити')
check('the same translation again changes nothing', !m.dirty)
m.put('en', 'uk', 'Close', 'Зачинити')
check('a better translation replaces the old one', m.get('en', 'uk', 'Close') === 'Зачинити' && m.dirty)
m.put('en', 'uk', 'OK', 'OK')
check('an unchanged text is not kept', m.get('en', 'uk', 'OK') === null)
m.put('en', 'uk', 'x'.repeat(TranslationMemory.MAX_LENGTH + 1), 'довгий')
check('a very long text is not kept', m.get('en', 'uk', 'x'.repeat(TranslationMemory.MAX_LENGTH + 1)) === null)
// the limit: the least used texts go
const big = new TranslationMemory()
big.load('1', 'G', { entries: {}, glossary: {} })
for (let i = 0; i < TranslationMemory.MAX_ENTRIES + 300; i++) big.put('en', 'uk', 'text ' + i, 'переклад ' + i)
for (let i = 0; i < 50; i++) { big.get('en', 'uk', 'text 7'); }
big.prune()
check('the memory does not grow past its limit', big.entries.size <= TranslationMemory.MAX_ENTRIES)
check('a text that is used often stays', big.get('en', 'uk', 'text 7') === 'переклад 7')
const snapshot = big.snapshot()
check('the snapshot is what is written', Object.keys(snapshot.entries).length === big.entries.size && snapshot.name === 'G')
// a file with a broken entry is read without it
const broken = new TranslationMemory()
broken.load('2', 'G', { entries: { a: { t: 'ok', n: 1, at: Date.now() }, b: null as any, c: { t: 5 as any, n: 1, at: Date.now() } }, glossary: { g: 7 as any } })
check('broken entries are left out', broken.entries.size === 1 && broken.glossary.size === 0)
process.exit(bad)
