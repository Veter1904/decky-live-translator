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


// usage: node seqtest.cjs <dir> <truth.json> <A.png> <B.png>
// The picture shows A until the engine has translated it, then it changes to B. Measures how long A's plates stay after the change
// (the stale time), and how long until B's text is shown.
const dir = process.argv[2]
const truth = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const A = process.argv[4], B = process.argv[5]

async function load(file: string) {
    const { data, info } = await sharp(path.join(dir, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return { w: info.width, h: info.height, px: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) }
}
async function main() {
    const a = await load(A), b = await load(B)
    video.videoWidth = a.w; video.videoHeight = a.h; video.data = a.px
    let shown: string[] = []
    const engine = new ElementsEngine({
        getVideo: () => video,
        getBox: () => ({ width: video.videoWidth, height: video.videoHeight }),
        getSettings: () => ({ fit: 'default', source: 'en', target: 'uk', color: 'light', panels: true }),
        getManualRegions: () => [],
        translate: async (text: string) => { await new Promise(r => setTimeout(r, 150)); return 'UA[' + text + ']' },
        onResults: (results: any[]) => { shown = results.flatMap((r: any) => r.result.segments.map((s: any) => s.original)) },
        onStatus: () => {},
    } as any)
    engine.start()
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const expA = truth[A] as string[], expB = truth[B] as string[]
    // wait until at least half of A's text is shown (at most 40 s)
    let t = Date.now()
    while(Date.now() - t < 40000){ await sleep(100); if(expA.filter(e => shown.some(s => matches(e, s))).length >= Math.ceil(expA.length / 2)) break }
    await sleep(1500)
    const shownA = expA.filter(e => shown.some(s => matches(e, s))).length
    // the change
    video.videoWidth = b.w; video.videoHeight = b.h; video.data = b.px
    const t0 = Date.now()
    let staleGone = -1, bFirst = -1
    while(Date.now() - t0 < 30000){
        await sleep(50)
        const staleNow = expA.filter(e => shown.some(s => matches(e, s)) && !expB.some(x => matches(x, e))).length
        if(staleGone < 0 && staleNow === 0) staleGone = Date.now() - t0
        if(process.env.DBG && Date.now() - t0 > 600 && !(globalThis as any)._p && ((globalThis as any)._p = 1)) console.log('STALE at 600ms:', JSON.stringify(expA.filter(e => shown.some(s => matches(e, s)) && !expB.some(x => matches(x, e)))), 'shown now', JSON.stringify(shown))
        if(bFirst < 0 && expB.some(e => shown.some(s => matches(e, s)))) bFirst = Date.now() - t0
        if(staleGone >= 0 && bFirst >= 0) break
    }
    await sleep(1000)
    const bShown = expB.filter(e => shown.some(s => matches(e, s))).length
    console.log((A + ' -> ' + B).padEnd(34), 'A shown', shownA + '/' + expA.length, ' stale gone after', staleGone < 0 ? 'NEVER' : staleGone + ' ms', ' B first after', bFirst < 0 ? 'NEVER' : bFirst + ' ms', ' B shown', bShown + '/' + expB.length)
    engine.stop()
    process.exit(0)
}
main()
