import { install, video } from './realcanvas'
install()
if (process.env.COLORSCALE) (globalThis as any).DLT_COLOR_SCALE = Number(process.env.COLORSCALE)
import { ocrStats, setReaderMode } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ocr'
import { initPpocr, setWordList } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ppocr'
import ElementsEngine from 'E:/Greenlight/packages/desktop/renderer/lib/translator/elements'
const sharp = require('E:/Greenlight/node_modules/sharp')
const fs = require('fs'), path = require('path')

// usage: [IDLE=1] node evalset.js <seconds> <frames dir> <truth.json> [only]   (IDLE=1: run until the engine is quiet: repeatable)
const seconds = parseInt(process.argv[2] || '15')
const dir = process.argv[3]
const truth = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'))
const only = process.argv[5]

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

// A stand-in for a translation that is as long as a Ukrainian one (a letter for a letter in Cyrillic, words a little longer)
function translit(text: string): string {
    const map: any = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'і', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'и', z: 'з' }
    return text.replace(/[A-Za-z]+/g, (w) => { const t = w.toLowerCase().split('').map((c) => map[c] ?? c).join(''); return w.length > 3 ? t + 'ть' : t })
}

async function run(file: string, expected: string[]) {
    const { data, info } = await sharp(path.join(dir, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    video.videoWidth = info.width
    video.videoHeight = info.height
    video.data = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
    let shown: string[] = []
    const engine = new ElementsEngine({
        getVideo: () => video,
        getBox: () => ({ width: video.videoWidth, height: video.videoHeight }),
        getSettings: () => ({ fit: 'default', source: 'en', target: 'uk', color: 'light', panels: true }),
        getManualRegions: () => [],
        translate: async (text: string) => process.env.TRANSLIT ? translit(text) : 'UA[' + text + ']',
        onResults: (results: any[]) => { (globalThis as any)._lastRes = results; if(process.env.DBG) console.log('RES', results.length, JSON.stringify(results.map((r: any) => r.result.segments.map((s: any) => s.original)))); shown = results.flatMap(r => r.result.segments.map((s: any) => s.original)) },
        onStatus: () => {},
    } as any)
    engine.start()
    if(process.env.IDLE){
        // Deterministic: not a fixed time but until the engine has nothing left to read or translate (for 2 s), at most 90 s
        const t0 = Date.now(); let quiet = 0
        while(Date.now() - t0 < 90000){
            await new Promise(r => setTimeout(r, 250))
            const busy = (engine as any)._elements.some((e: any) => e.reading || e.dirty || e.state === 'new')
            quiet = busy ? 0 : quiet + 250
            if(quiet >= 2000 && Date.now() - t0 >= 3000) break
        }
    } else {
        await new Promise(r => setTimeout(r, seconds * 1000))
    }
    const stats = { reads: ocrStats.reads, ms: ocrStats.ms }; ocrStats.reads = 0; ocrStats.ms = 0
    const dbg = engine.getCount(); if(process.env.DBG){ engine.getDebug().forEach((l: string) => console.log('     ', l)) }
    if(process.env.DUMP){ require('fs').writeFileSync(process.env.DUMP + '_' + file.replace(/[.]png$/, '') + '.jsonl', JSON.stringify({ t: 0, source: 'layer', elements: dbg, results: (globalThis as any)._lastRes.map((r: any) => ({ id: r.id, segments: r.result.segments.map((g: any) => ({ o: g.original, t: g.translated, r: g.rect, lh: g.lineHeight, c: g.centered, bg: g.background, fg: g.foreground })) })) }) + String.fromCharCode(10)) }
    if(process.env.POLDBG){ (engine as any)._elements.filter((e: any) => e.segments.length).forEach((e: any) => console.log('POL', e.id, e.polarity, 'det', e.detected === true, 'score', Math.round(e.score), e.segments.map((g: any) => g.original.slice(0, 24) + ' bg' + JSON.stringify(g.background) + ' base' + JSON.stringify(g.base) + ' fg' + g.foreground).join(' | '))) }
    const finalShown = shown.slice()
    engine.stop()
    shown = finalShown
    const found = expected.filter(e => shown.some(s => matches(e, s)))
    const missed = expected.filter(e => !found.includes(e))
    const extra = shown.filter(s => !expected.some(e => matches(e, s)))
    console.log(file.padEnd(16), 'found', found.length + '/' + expected.length, ' elements', dbg, ' shown', shown.length, ' OCR reads', stats.reads, 'ms', stats.ms)
    if(missed.length) console.log('   MISSED:', missed.join(' | '))
    if(extra.length) console.log('   EXTRA :', extra.map(s => JSON.stringify(s)).join(' '))
    return { found: found.length, total: expected.length, extra: extra.length }
}

async function main() {
    // READER=ppocr | both: PP-OCR (onnxruntime-node, models in PPOCR_DIR) reads the pictures (see ppocr.ts)
    if(process.env.READER && process.env.READER !== 'tesseract'){
        const dir = process.env.PPOCR_DIR || (process.env.PPOCR_HOME || 'ppocr') + '/models'
        await initPpocr(require((process.env.PPOCR_HOME || 'ppocr') + '/node_modules/onnxruntime-node'), path.join(dir, 'det.onnx'), path.join(dir, 'rec.onnx'), fs.readFileSync(path.join(dir, 'keys.txt'), 'utf8'))
        if (!process.env.NOWORDS) setWordList(require('fs').readFileSync('E:/decky-live-translator/assets/ocr/words-en.txt', 'utf8'))
        setReaderMode(process.env.READER as any)
    }
    let found = 0, total = 0, extra = 0
    for(const file of Object.keys(truth)){
        if(only && !file.includes(only)) continue
        const r = await run(file, truth[file])
        found += r.found; total += r.total; extra += r.extra
    }
    console.log('TOTAL recall', found + '/' + total, (100 * found / Math.max(1, total)).toFixed(0) + '%', ' extra readings', extra)
    process.exit(0)
}
main()
