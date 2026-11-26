import { install, video } from './realcanvas'
install()
import { ocrStats } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ocr'
import ElementsEngine from 'E:/Greenlight/packages/desktop/renderer/lib/translator/elements'
const sharp = require('E:/Greenlight/node_modules/sharp')
const fs = require('fs'), path = require('path')

// usage: [IDLE=1] node evalset.js <seconds> <frames dir> <truth.json> [only]   (IDLE=1: run until the engine is quiet: repeatable)
const seconds = parseInt(process.argv[2] || '15')

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
function lev(a: string, b: string): number {
    const m = a.length, n = b.length
    if(!m || !n) return Math.max(m, n)
    let prev = Array.from({ length: n + 1 }, (_, i) => i)
    for(let i = 1; i <= m; i++){
        const cur = [i]
        for(let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
        prev = cur
    }
    return prev[n]
}
// Smallest number of edits to turn `e` into any substring of `r` (Sellers)
function approxContains(e: string, r: string): number {
    const m = e.length, n = r.length
    let prev = new Array(n + 1).fill(0)
    for(let i = 1; i <= m; i++){
        const cur = [i]
        for(let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (e[i - 1] === r[j - 1] ? 0 : 1))
        prev = cur
    }
    return Math.min(...prev)
}
// does the reading contain the expected text (fuzzy: up to a quarter of the letters wrong)
function matches(expected: string, reading: string): boolean {
    const e = norm(expected), r = norm(reading)
    if(!e || !r) return false
    if(r.includes(e)) return true
    // the reading holds the expected text with a few mistakes (it may hold more: lines read together)
    if(r.length >= e.length * 0.7 && approxContains(e, r) <= Math.max(1, Math.floor(e.length * 0.25))) return true
    // a reading that is a part of a longer expected text (a paragraph read in pieces)
    return e.length > 12 && r.length > 8 && e.includes(r)
}



// usage: node typetest.cjs <png with a line of text> <x0> <x1> <y0> <y1> <expected text>
// The text line is typed letter by letter (the right part of the place is painted over with the colour of the background and uncovered
// in steps of STEP ms). Prints every different text that was ever shown: partial texts are the fault.
const file = process.argv[2]
const [x0, x1, y0, y1] = process.argv.slice(3, 7).map(Number)
const expected = process.argv[7]
const STEP = Number(process.env.STEP || 250)

async function main() {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const full = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
    const w = info.width, h = info.height
    // background colour: the pixel just left of the text
    const bo = ((y0 + y1 >> 1) * w + (x0 - 20)) * 4
    const bg = [full[bo], full[bo + 1], full[bo + 2]]
    const frameAt = (fraction: number) => {
        const copy = full.slice()
        const cut = Math.round(x0 + (x1 - x0) * fraction)
        for(let y = y0; y < y1; y++) for(let x = cut; x < x1 + 6; x++){ const o = (y * w + x) * 4; copy[o] = bg[0]; copy[o + 1] = bg[1]; copy[o + 2] = bg[2] }
        return copy
    }
    video.videoWidth = w; video.videoHeight = h; video.data = frameAt(0.0)
    const seen: string[] = []
    let t0 = 0
    const engine = new ElementsEngine({
        getVideo: () => video,
        getBox: () => ({ width: video.videoWidth, height: video.videoHeight }),
        getSettings: () => ({ fit: 'default', source: 'en', target: 'uk', color: 'light', panels: true }),
        getManualRegions: () => [],
        translate: async (text: string) => { await new Promise(r => setTimeout(r, 100)); return 'UA[' + text + ']' },
        onResults: (results: any[]) => { for(const r of results) for(const s of r.result.segments){ if(!seen.some(x => x.endsWith(s.original))) seen.push(((Date.now() - t0) + 'ms ') + s.original) } },
        onStatus: () => {},
    } as any)
    engine.start()
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    await sleep(1500)
    t0 = Date.now()
    for(const f of [0.2, 0.4, 0.6, 0.8, 1.0]){ video.data = frameAt(f); await sleep(STEP) }
    await sleep(6000)
    console.log('expected:', expected, ' typed in', STEP * 5, 'ms; texts shown:', JSON.stringify(seen))
    engine.stop(); process.exit(0)
}
main()
