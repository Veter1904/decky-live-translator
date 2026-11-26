// Runs on the Deck inside the Steam UI (through scripts/cdp_eval.py): starts the local translator, loads en->uk and measures.
import { LocalTranslator } from '../../src/local'
declare const BASE: string
;(globalThis as any).dltLocalTest = async (base: string) => {
    const t0 = performance.now()
    const local = new LocalTranslator(base, (m) => console.log(m))
    await local.start()
    const tStart = performance.now() - t0
    const t1 = performance.now()
    await local.loadPair('en', 'uk')
    const tLoad = performance.now() - t1
    const pairs = LocalTranslator.pairs('en', 'uk', ['enuk'])
    const samples = ['NEW GAME', 'Obtained a Life Capsule.', "Didn't I just tell you it's time to sleep?", 'Lucky we still get the usual clients! Otherwise, I would have closed this place many years ago.', 'Is this rain so dangerous?', 'Kazuma: answer me', 'Seen worse.', 'Settings']
    const out: any[] = []
    for (const s of samples) { const t = performance.now(); const r = await local.translate(s, pairs); out.push([s, r, Math.round(performance.now() - t)]) }
    // repeat for the speed of warm calls
    const t2 = performance.now()
    for (let i = 0; i < 20; i++) await local.translate(samples[3], pairs)
    const warm = (performance.now() - t2) / 20
    local.stop()
    return { startMs: Math.round(tStart), loadMs: Math.round(tLoad), warmLongMs: Math.round(warm), out }
}
