// The memory forgets texts that were used once and not lately (they are reading mistakes or one-time texts), and keeps the rest.
import { TranslationMemory, memoryKey } from '../../src/memory'
let bad = 0
const check = (label: string, ok: boolean) => { console.log((ok ? 'ok   ' : 'FAIL ') + label); if (!ok) bad++ }
const day = 86400000
const now = Date.now()
const m = new TranslationMemory()
m.load('1', 'G', {
    entries: {
        [memoryKey('en', 'uk', 'old once')]: { t: 'старий раз', n: 1, at: now - 90 * day },
        [memoryKey('en', 'uk', 'old often')]: { t: 'старий часто', n: 8, at: now - 90 * day },
        [memoryKey('en', 'uk', 'new once')]: { t: 'новий раз', n: 1, at: now - 5 * day },
        [memoryKey('en', 'uk', 'old twice')]: { t: 'старий двічі', n: 2, at: now - 200 * day },
    },
    glossary: {},
})
check('a text used once and not for 60 days is forgotten', m.get('en', 'uk', 'old once') === null)
check('a text used often is kept however old', m.get('en', 'uk', 'old often') === 'старий часто')
check('a text used once but lately is kept', m.get('en', 'uk', 'new once') === 'новий раз')
check('a text used twice is kept', m.get('en', 'uk', 'old twice') === 'старий двічі')
process.exit(bad)
