import { install, video } from './realcanvas'
import { setReaderMode } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ocr'
import { initPpocr, setWordList } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ppocr'
install()
;(globalThis as any).DLT_OLDNEED = process.env.OLDNEED === '1'
;(globalThis as any).DLT_OLDATTEMPTS = process.env.OLDATTEMPTS === '1'
if (process.env.COLORSCALE) (globalThis as any).DLT_COLOR_SCALE = Number(process.env.COLORSCALE)
import { readTimes } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/engine'
import ElementsEngine, { scrollStats } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/elements'
const sharp = require('E:/Greenlight/node_modules/sharp')
const fs = require('fs'), path = require('path')

// usage: [READER=both] [EVERY=0.5] node playback.cjs <record dir> [hold seconds]
// Plays the frames of a recording made on the Deck at the times they were taken and prints what the engine shows.
const dir = process.argv[2]
const hold = parseFloat(process.argv[3] || '3')
const every = parseFloat(process.env.EVERY || '0.5')
const slow = parseFloat(process.env.SLOW || '1')
;(globalThis as any).DLT_NOSCROLL = process.env.NOSCROLL === '1'

async function main() {
    if(process.env.READER && process.env.READER !== 'tesseract'){
        const models = (process.env.PPOCR_HOME || 'ppocr') + '/models'
        await initPpocr(require((process.env.PPOCR_HOME || 'ppocr') + '/node_modules/onnxruntime-node'), path.join(models, 'det.onnx'), path.join(models, 'rec.onnx'), fs.readFileSync(path.join(models, 'keys.txt'), 'utf8'))
        if (!process.env.NOWORDS) setWordList(require('fs').readFileSync('E:/decky-live-translator/assets/ocr/words-en.txt', 'utf8'))
        setReaderMode(process.env.READER as any)
    }
    const index = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l))
    const frames: Uint8ClampedArray[] = []
    for(const meta of index){
        const { data, info } = await sharp(path.join(dir, 'f' + String(meta.n).padStart(3, '0') + '.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        video.videoWidth = info.width
        video.videoHeight = info.height
        frames.push(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length))
    }
    if (process.env.FREEZE) { const n = Number(process.env.FREEZE); frames.splice(0, frames.length, frames[n]); index.splice(0, index.length, { ...index[n], t: index[0].t }) }
    // WARM=n: the engine first runs for n seconds on a black picture (it is started and ready), then the screen appears: the times are counted from that moment
    const warm = Number(process.env.WARM || 0)
    if (warm > 0) { frames.unshift(new Uint8ClampedArray(frames[0].length).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 0))); index.unshift({ ...index[0], t: index[0].t - warm / slow }) }
    const times: number[] = index.map((m: any) => (m.t - index[0].t) * slow)
    video.data = frames[0]
    let shown: Array<{ y: number; x: number; o: string; t: string }> = []
    const engine = new ElementsEngine({
        getVideo: () => video,
        getBox: () => ({ width: video.videoWidth, height: video.videoHeight }),
        getSettings: () => ({ fit: 'default', source: 'en', target: 'uk', color: 'light', panels: true }),
        getManualRegions: () => [],
        speed: () => Number(process.env.SPEED || 1),
        getPlateRects: () => (process.env.PLATES ? JSON.parse(process.env.PLATES) : []),
        translate: async (text) => { await new Promise(r => setTimeout(r, 60)); return 'UA[' + text.slice(0, 14) + ']' },
        onResults: (results) => {
            shown = []
            for(const r of results) for(const s of r.result.segments) shown.push({ y: Math.round(s.rect.y * video.videoHeight), x: Math.round(s.rect.x * video.videoWidth), o: s.original + ((s as any).clip ? ' [CLIP y' + Math.round((s as any).clip.y * video.videoHeight) + '+' + Math.round((s as any).clip.h * video.videoHeight) + ']' : '') + ((s as any).motion ? ' {v' + Math.round((s as any).motion.vy * 800) + (((s as any).motion.sustained) ? 's' : '') + '}' : ''), t: s.translated })
            shown.sort((a, b) => a.y - b.y)
        },
        onStatus: () => { /* quiet */ },
    })
    engine.start()
    const t0 = Date.now()
    let frame = 0
    const total = times[times.length - 1] + hold
    const timer = setInterval(() => {
        const now = (Date.now() - t0) / 1000
        while(frame + 1 < frames.length && times[frame + 1] <= now) frame++
        video.data = frames[frame]
    }, 50)
    let nextPrint = 0
    const firstSeen = new Map<string, number>()
    const printer = setInterval(() => {
        for (const s of shown) { const key = s.o.slice(0, 20) + Math.round(s.y / 20); if (!firstSeen.has(key)) firstSeen.set(key, (Date.now() - t0) / 1000 - warm) }
        const now = (Date.now() - t0) / 1000
        if (process.env.STATES) {
            const els: any[] = (engine as any)._elements
            const count = (f: (e: any) => boolean) => els.filter(f).length
            console.log((now - warm).toFixed(1) + 's STATES elements ' + els.length + ' new ' + count(e => e.state === 'new') + ' (seen>=need ' + count(e => e.state === 'new' && e.seen >= (engine as any)._need(e)) + ') dirty ' + count(e => e.dirty) + ' changing ' + count(e => e.changing === true) + ' reading ' + count(e => e.reading) + ' text ' + count(e => e.state === 'text') + ' dead ' + count(e => e.state === 'dead') + ' scans ' + (engine as any)._scans + ' detectedAt ' + ((engine as any)._detectedAt ? 'yes' : 'no'))
        }
        console.log(now.toFixed(1) + 's frame ' + frame + ' shown ' + shown.length)
        for(const s of shown) console.log('      y' + String(s.y).padStart(4) + ' x' + String(s.x).padStart(4) + '  ' + s.o.slice(0, 44).padEnd(44) + ' -> ' + s.t.slice(0, 20))
        nextPrint += every
    }, every * 1000)
    setTimeout(() => { { const t = Array.from(firstSeen.values()).sort((a, b) => a - b); const at = (q: number) => t.length ? t[Math.min(t.length - 1, Math.floor(q * t.length))].toFixed(1) : '-'; console.log('first plates: n', t.length, ' 25%', at(0.25), 's  50%', at(0.5), 's  90%', at(0.9), 's  last', t.length ? t[t.length - 1].toFixed(1) : '-', 's') }; console.log('read times (ms): prepare', readTimes.prepare, 'recognize', readTimes.recognize, 'reads', readTimes.reads, '| draw+getImageData', readTimes.draw, 'colors copy+breathe', readTimes.pixels, 'ink masks', readTimes.ink); console.log('scroll stats', JSON.stringify({ ...scrollStats, scores: scrollStats.scores.join(',') })); clearInterval(timer); clearInterval(printer); engine.stop(); process.exit(0) }, total * 1000)
}
main()
