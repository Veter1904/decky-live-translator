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




// usage: node flickertest.cjs <png> <x0> <x1> <y0> <y1>
// A menu entry changes its look (the colours of the place are turned over: a highlighted entry) every few seconds while its text stays the same.
// Prints for how long the translation of the text was missing (a plate that blinks away is the fault).
const file = process.argv[2]
const [x0, x1, y0, y1] = process.argv.slice(3, 7).map(Number)
async function loadFrames(prefix: string, n: number) { const out: Uint8ClampedArray[] = []; for(let i = 0; i < n; i++){ const { data } = await sharp(prefix + i + '.png').ensureAlpha().raw().toBuffer({ resolveWithObject: true }); out.push(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)) } return out }
async function noisy() {
    const frames = await loadFrames('../sets/gt7/menu_busy', 4)
    video.videoWidth = 1920; video.videoHeight = 1080; video.data = frames[0]
    let shownNow = false
    const engine = new ElementsEngine({
        getVideo: () => video,
        getBox: () => ({ width: video.videoWidth, height: video.videoHeight }),
        getSettings: () => ({ fit: 'default', source: 'en', target: 'uk', color: 'light', panels: true }),
        getManualRegions: () => [],
        translate: async (text: string) => { await new Promise(r => setTimeout(r, 80)); return 'UA[' + text + ']' },
        onResults: (results: any[]) => { shownNow = results.some((r: any) => r.result.segments.some((s: any) => matches('NEW GAME', s.original))) },
        onStatus: () => {},
    } as any)
    engine.start()
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const t0 = Date.now()
    while(Date.now() - t0 < 15000 && !shownNow) await sleep(100)
    ocrStats.reads = 0
    let missing = 0, total = 0, k = 0
    const end = Date.now() + 20000
    while(Date.now() < end){ video.data = frames[(k++) % 4]; for(let i = 0; i < 8; i++){ await sleep(50); total += 50; if(!shownNow) missing += 50 } if(process.env.TRACE) console.log('t', Date.now() - t0, 'shown', shownNow) }
    if(process.env.DBG){ engine.getDebug().forEach((l: string) => console.log('  ', l)) }
    console.log('the background changed', k, 'times (the text stayed); the translation was missing', missing, 'ms of', total, 'ms; readings:', ocrStats.reads)
    engine.stop(); process.exit(0)
}
async function colours() {
    const frames = await loadFrames('../sets/gt7/menu_', 0).catch(() => [])
    const load = async (f: string) => { const { data } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) }
    const blue = await load('../sets/gt7/menu_blue.png'), red = await load('../sets/gt7/menu_red.png')
    video.videoWidth = 1920; video.videoHeight = 1080; video.data = blue
    let shownNow = false, colour: any = null
    const engine = new ElementsEngine({
        getVideo: () => video,
        getBox: () => ({ width: video.videoWidth, height: video.videoHeight }),
        getSettings: () => ({ fit: 'default', source: 'en', target: 'uk', color: 'light', panels: true }),
        getManualRegions: () => [],
        translate: async (text: string) => { await new Promise(r => setTimeout(r, 80)); return 'UA[' + text + ']' },
        onResults: (results: any[]) => { const seg = results.flatMap((r: any) => r.result.segments).find((s: any) => matches('NEW GAME', s.original)); shownNow = !!seg; if(seg) colour = seg.background },
        onStatus: () => {},
    } as any)
    engine.start()
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const t0 = Date.now()
    while(Date.now() - t0 < 15000 && !shownNow) await sleep(100)
    await sleep(1500)
    console.log('start      plate background', JSON.stringify(colour))
    let missing = 0, total = 0
    for(const [name, frame] of [['red', red], ['blue', blue], ['red', red]] as Array<[string, Uint8ClampedArray]>){
        video.data = frame
        const until = Date.now() + 5000
        while(Date.now() < until){ await sleep(50); total += 50; if(!shownNow) missing += 50 }
        console.log('background ' + name.padEnd(5) + ' plate background', JSON.stringify(colour))
    }
    console.log('the translation was missing', missing, 'ms of', total, 'ms')
    engine.stop(); process.exit(0)
}
async function main() {
    if(process.env.COLOURS){ await colours(); return }
    if(process.env.NOISY){ await noisy(); return }
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const plain = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
    const w = info.width, h = info.height
    const turned = plain.slice()
    for(let y = y0 - 14; y < y1 + 14; y++) for(let x = x0 - 40; x < x1 + 40; x++){ const o = (y * w + x) * 4; turned[o] = 255 - turned[o]; turned[o + 1] = 255 - turned[o + 1]; turned[o + 2] = 255 - turned[o + 2] }
    video.videoWidth = w; video.videoHeight = h; video.data = plain
    let shownNow = false
    const engine = new ElementsEngine({
        getVideo: () => video,
        getBox: () => ({ width: video.videoWidth, height: video.videoHeight }),
        getSettings: () => ({ fit: 'default', source: 'en', target: 'uk', color: 'light', panels: true }),
        getManualRegions: () => [],
        translate: async (text: string) => { await new Promise(r => setTimeout(r, 80)); return 'UA[' + text + ']' },
        onResults: (results: any[]) => { shownNow = results.some((r: any) => r.result.segments.some((s: any) => matches('NEW GAME', s.original))) },
        onStatus: () => {},
    } as any)
    engine.start()
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const t0 = Date.now()
    while(Date.now() - t0 < 12000 && !shownNow) await sleep(100)
    await sleep(1500)
    let missing = 0, total = 0, flips = 0
    for(let i = 0; i < 6; i++){
        video.data = i % 2 === 0 ? turned : plain; flips++
        const until = Date.now() + 3000
        while(Date.now() < until){ await sleep(50); total += 50; if(!shownNow) missing += 50 }
    }
    console.log('the look changed', flips, 'times; the translation was missing', missing, 'ms of', total, 'ms')
    engine.stop(); process.exit(0)
}
main()
