import { install, video } from './realcanvas'
import { setReaderMode } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ocr'
import { initPpocr, setWordList } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ppocr'
install()
if (process.env.COLORSCALE) (globalThis as any).DLT_COLOR_SCALE = Number(process.env.COLORSCALE)
import ElementsEngine from 'E:/Greenlight/packages/desktop/renderer/lib/translator/elements'
const sharp = require('E:/Greenlight/node_modules/sharp')
const fs = require('fs'), path = require('path')

// usage: [READER=both] node windowtest.cjs <dir with the frames of make_window_frames.py>
// A window of paragraphs is opened, scrolled down and up, closed and opened again, while the engine runs. Every half second each plate is judged against what is really on the screen:
//   ok: its text is on the screen, where the plate is;  stale: its text is known but is not (there) on the screen now;  junk: its text is not in the game at all.
// And the paragraphs and choices that are whole on the screen are asked for: those without a plate are missing.
const dir = process.argv[2]
const info = JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf8'))
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const bigrams = (s: string) => { const out = new Map<string, number>(); const t = norm(s).replace(/ /g, ''); for (let i = 0; i < t.length - 1; i++) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) ?? 0) + 1); return out }
const dice = (a: string, b: string) => { const x = bigrams(a), y = bigrams(b); let both = 0, nx = 0, ny = 0; x.forEach(v => nx += v); y.forEach(v => ny += v); x.forEach((v, k) => both += Math.min(v, y.get(k) ?? 0)); return nx + ny === 0 ? 0 : 2 * both / (nx + ny) }

// the scenario: [seconds, frame]
const scenario: Array<[number, string]> = [[0, 'base']]
scenario.push([4, 'w00'])
for (let i = 1; i <= 5; i++) scenario.push([16 + (i - 1) * 0.4, 'w0' + i])
for (let i = 4; i >= 0; i--) scenario.push([21 + (4 - i) * 0.4, 'w0' + i])
scenario.push([27, 'base'], [34, 'w00'])
const END = 44

async function main() {
    if (process.env.READER && process.env.READER !== 'tesseract') {
        const models = (process.env.PPOCR_HOME || 'ppocr') + '/models'
        await initPpocr(require((process.env.PPOCR_HOME || 'ppocr') + '/node_modules/onnxruntime-node'), path.join(models, 'det.onnx'), path.join(models, 'rec.onnx'), fs.readFileSync(path.join(models, 'keys.txt'), 'utf8'))
        setWordList(fs.readFileSync('E:/decky-live-translator/assets/ocr/words-en.txt', 'utf8'))
        setReaderMode(process.env.READER as any)
    }
    const frames = new Map<string, Uint8ClampedArray>()
    const truths = new Map<string, Array<{ kind: string; id: number; text: string; y0: number; y1: number }>>()
    const known: string[] = []
    for (const name of new Set(scenario.map(s => s[1]))) {
        const { data, info: im } = await sharp(path.join(dir, name + '.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        video.videoWidth = im.width; video.videoHeight = im.height
        frames.set(name, new Uint8ClampedArray(data.buffer, data.byteOffset, data.length))
        const t = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'))
        truths.set(name, name === 'base' ? [] : t.truth)
        for (const b of (name === 'base' ? [] : t.truth)) if (!known.includes(b.text)) known.push(b.text)
    }
    // every block of the content (also those that are cut at the edges in the frames above) is known text
    for (let i = 0; i < info.frames; i++) for (const b of JSON.parse(fs.readFileSync(path.join(dir, 'w' + String(i).padStart(2, '0') + '.json'), 'utf8')).truth) if (!known.some(k => k === b.text)) known.push(b.text)
    const H = video.videoHeight
    video.data = frames.get('base') as Uint8ClampedArray
    let shown: Array<{ y0: number; y1: number; o: string }> = []
    const engine = new ElementsEngine({
        getVideo: () => video,
        getBox: () => ({ width: video.videoWidth, height: video.videoHeight }),
        getSettings: () => ({ fit: 'default', source: 'en', target: 'uk', color: 'light', panels: true }),
        getManualRegions: () => [],
        speed: () => Number(process.env.SPEED || 0.7),
        translate: async (text) => { await new Promise(r => setTimeout(r, 60)); return 'UA[' + text.slice(0, 10) + ']' },
        onResults: (results) => {
            shown = []
            for (const r of results) for (const s of r.result.segments) shown.push({ y0: s.rect.y * H, y1: (s.rect.y + s.rect.h) * H, o: s.original })
        },
        onStatus: () => { /* quiet */ },
    })
    engine.start()
    const t0 = Date.now()
    let current = 'base'
    const timer = setInterval(() => {
        const now = (Date.now() - t0) / 1000
        for (const [at, name] of scenario) if (at <= now) current = name
        video.data = frames.get(current) as Uint8ClampedArray
    }, 40)
    const rows: Array<{ t: number; frame: string; ok: number; stale: number; junk: number; missing: number; wanted: number; sample: string }> = []
    // texts that are really on the screen besides the window: the scene of the game under it
    const scene = ['Blue Kingdom Transit Relay', 'Blue Kingdom', 'Transit Relay', '17th Mar 1905', '16th Mar 1905', '15th Mar 1905', 'Thrust', 'Brake', 'Steer']
    const words = (s: string) => norm(s).split(' ').filter(w => w.length >= 3)
    const blocks = [...known.map(text => ({ text, tokens: new Set(words(text)) })), ...scene.map(text => ({ text, tokens: new Set(words(text)) }))]
    const sampler = setInterval(() => {
        const now = (Date.now() - t0) / 1000
        const truth = truths.get(current) ?? []
        let ok = 0, stale = 0, junk = 0
        const seen = truth.map(() => new Set<string>())
        const bad: string[] = []
        for (const plate of shown) {
            const mine = words(plate.o)
            let best = -1, bestScore = 0
            blocks.forEach((blk, i) => { if (mine.length === 0) return; const hit = mine.filter(w => blk.tokens.has(w)).length / mine.length; if (hit > bestScore) { bestScore = hit; best = i } })
            // a text of the scene under the window (its words are all words of that text)
            const sceneHit = scene.find(text => mine.length >= 1 && mine.every(w => words(text).includes(w)))
            if (sceneHit !== undefined && mine.length >= 1) { ok++; continue }
            if (best < 0 || bestScore < 0.7 || mine.length < 2) { junk++; bad.push('JUNK ' + plate.o.slice(0, 40)); continue }
            const blk = blocks[best]
            const here = truth.findIndex(b => b.text === blk.text && (plate.y0 + plate.y1) / 2 > b.y0 - 70 && (plate.y0 + plate.y1) / 2 < b.y1 + 70)
            if (here < 0) { stale++; bad.push('STALE ' + plate.o.slice(0, 40)); continue }
            ok++
            mine.forEach(w => seen[here].add(w))
        }
        const missing = truth.filter((b, i) => seen[i].size < 0.7 * new Set(words(b.text)).size).length
        if (process.env.DUMP && Math.abs(now - Number(process.env.DUMP)) < 0.26) { console.log('PLATES at ' + now.toFixed(1)); shown.slice().sort((a, b) => a.y0 - b.y0).forEach(pl => console.log('    y ' + Math.round(pl.y0) + '-' + Math.round(pl.y1) + '  ' + pl.o.slice(0, 80))) }
        rows.push({ t: now, frame: current, ok, stale, junk, missing, wanted: truth.length, sample: bad.slice(0, 2).join(' | ') })
    }, 500)
    await new Promise(r => setTimeout(r, END * 1000))
    clearInterval(timer); clearInterval(sampler); engine.stop()

    for (const r of rows) console.log(r.t.toFixed(1).padStart(5) + 's ' + r.frame.padEnd(5) + ' ok ' + r.ok + ' wanted ' + r.wanted + ' missing ' + r.missing + ' stale ' + r.stale + ' junk ' + r.junk + (r.sample ? '   ' + r.sample : ''))
    const phase = (a: number, b: number) => rows.filter(r => r.t >= a && r.t < b)
    const max = (rs: typeof rows, f: (r: typeof rows[0]) => number) => rs.reduce((m, r) => Math.max(m, f(r)), 0)
    const sum = (label: string, rs: typeof rows) => console.log(label.padEnd(34) + 'max junk ' + max(rs, r => r.junk) + '  max stale ' + max(rs, r => r.stale) + '  samples with something missing ' + rs.filter(r => r.missing > 0).length + '/' + rs.length)
    console.log('---------- summary')
    sum('open (4-10 s: reading)', phase(4, 10))
    sum('static window (10-16 s)', phase(10, 16))
    sum('scrolled down (16.5-21 s)', phase(16.5, 21))
    sum('scrolled up (21.5-27 s)', phase(21.5, 27))
    sum('closed (27-28 s)', phase(27, 28))
    sum('closed (28-34 s)', phase(28, 34))
    sum('opened again (34-38 s)', phase(34, 38))
    sum('opened again, settled (38-44 s)', phase(38, 44))
    process.exit(0)
}
main()
