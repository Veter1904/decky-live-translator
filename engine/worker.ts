/// <reference lib="webworker" />
// The engine worker: everything heavy (looking at the picture, reading, tracking elements) happens here, off the page of Steam.
// Messages in:  init {base, scoutCode, settings}, frame {buf, w, h, masks}, settings {settings}, stop
// Messages out: ready, ack (frame taken), results {results}, status {status}, translate {id, text, source, target}, debug {lines}
import ElementsEngine from './vendor/elements'
import { glossaryTranslation } from './vendor/uiwords'
import { ocrStats, setReaderMode } from './vendor/ocr'
import { abandonRemoteReader, initPpocr, ppocrStats, remoteStats, serveReader, setWordList, useRemoteReaders } from './vendor/ppocr'
import { initEnv, makeCanvas } from './env'
import { findStops } from './obstacles'

const ctx: any = self

// The "video" the engine looks at: a canvas that holds the last frame WITHOUT our own plates (see applyFrame)
const video: any = makeCanvas()
video.videoWidth = 0
video.videoHeight = 0
video.readyState = 4
const videoContext = video.getContext('2d', { willReadFrequently: true })

let settings: any = { fit: 'default', source: 'en', target: 'uk', color: 'light', panels: true }
let engine: ElementsEngine | null = null
let clean: Uint8ClampedArray | null = null
let framesTaken = 0
const waiting = new Map<number, { resolve: (answer: any) => void; reject: (error: Error) => void }>()
const betterWaiting = new Map<number, (text: string | null) => void>()
let nextTranslate = 1

/** Our own plates are in the captured picture. The pixels under them keep what was there before the plate came, so the
 *  engine never reads its own translation (and keeps the element alive while the plate covers it). */
// A coarse picture (64 x 40, grey) of the last live frame, to tell a clean game picture from stale rubbish: when the game has nothing on
// screen yet, gamescope hands out an old picture that was left in its memory (another game, another screen)
const SMALL_W = 64
const SMALL_H = 40
let liveSmall: Uint8Array | null = null
let liveMasks: Array<[number, number, number, number]> = []
let liveSize = { w: 0, h: 0 }
let livePixels: Uint8ClampedArray | null = null
const CLEAN_MAX_DIFF = 32
// After the picture changes a lot (a new screen) the reader works without its limit for a while: the new text is wanted at once
const SCENE_DIFF = 18
const BURST_MS = 12000
let burstUntil = Date.now() + BURST_MS
const cleanChecks = { checked: 0, changed: 0 }

function smallLuma(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
    const out = new Uint8Array(SMALL_W * SMALL_H)
    for (let j = 0; j < SMALL_H; j++) {
        const y = Math.min(h - 1, Math.floor((j + 0.5) * h / SMALL_H))
        for (let i = 0; i < SMALL_W; i++) {
            const x = Math.min(w - 1, Math.floor((i + 0.5) * w / SMALL_W))
            const o = (y * w + x) * 4
            out[j * SMALL_W + i] = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000
        }
    }
    return out
}

/**
 * Does the "clean" picture contain our plates? Gamescope cannot always separate Steam's layer (a game that does not fill the output, for
 * example, is composited into one picture). Inside our plates such a picture has the same pattern as the live frame (the ratio of the
 * difference to the spread of the live pixels is near 0); a really clean one has the original text there (ratio 0.5 and more).
 */
const CONTAMINATED_RATIO = 0.25
function cleanHasPlates(clean: Uint8ClampedArray, w: number, h: number): boolean {
    if (livePixels === null || livePixels.length !== clean.length || liveSize.w !== w || liveSize.h !== h) return false
    let total = 0
    let used = 0
    for (const [x0, y0, x1, y1] of liveMasks.slice(0, 16)) {
        const ax = Math.max(0, x0 + 4), ay = Math.max(0, y0 + 4), bx = Math.min(w, x1 - 4), by = Math.min(h, y1 - 4)
        let n = 0, sum = 0, sum2 = 0, diff = 0
        for (let y = ay; y < by; y += 2) {
            for (let x = ax; x < bx; x += 2) {
                const o = (y * w + x) * 4
                const a = (livePixels[o] * 299 + livePixels[o + 1] * 587 + livePixels[o + 2] * 114) / 1000
                const b = (clean[o] * 299 + clean[o + 1] * 587 + clean[o + 2] * 114) / 1000
                sum += a; sum2 += a * a; diff += Math.abs(a - b); n++
            }
        }
        if (n < 150) continue
        const mean = sum / n
        const spread = Math.max(12, Math.sqrt(Math.max(1, sum2 / n - mean * mean)))
        total += diff / n / spread
        used++
    }
    return used > 0 && total / used < CONTAMINATED_RATIO
}

/** How different the clean picture is from the live one (mean difference of grey, 0..255), outside our plates. */
function cleanDifference(small: Uint8Array): number {
    if (liveSmall === null) return 0
    let sum = 0
    let count = 0
    for (let j = 0; j < SMALL_H; j++) {
        for (let i = 0; i < SMALL_W; i++) {
            const x = (i + 0.5) * liveSize.w / SMALL_W
            const y = (j + 0.5) * liveSize.h / SMALL_H
            if (liveMasks.some(([x0, y0, x1, y1]) => x >= x0 - 16 && x <= x1 + 16 && y >= y0 - 16 && y <= y1 + 16)) continue
            sum += Math.abs(small[j * SMALL_W + i] - liveSmall[j * SMALL_W + i])
            count++
        }
    }
    return count === 0 ? 0 : sum / count
}

/** The frame comes as the sink has it (gamescope: BGRx). The canvas wants RGBA with a real alpha. */
function toRgba(buf: ArrayBuffer, fmt: string) {
    if (fmt === 'RGBA') return
    const px = new Uint32Array(buf)
    if (fmt === 'BGRx' || fmt === 'BGRA') {
        for (let i = 0; i < px.length; i++) {
            const v = px[i]
            px[i] = 0xFF000000 | ((v & 0xFF) << 16) | (v & 0xFF00) | ((v >>> 16) & 0xFF)
        }
    } else if (fmt === 'ABGR2101010') {
        // 10 bits per channel (R in the low bits): the top 8 of each
        for (let i = 0; i < px.length; i++) {
            const v = px[i]
            px[i] = 0xFF000000 | ((((v >>> 20) & 0x3FF) >>> 2) << 16) | ((((v >>> 10) & 0x3FF) >>> 2) << 8) | ((v & 0x3FF) >>> 2)
        }
    } else if (fmt === 'ARGB2101010') {
        for (let i = 0; i < px.length; i++) {
            const v = px[i]
            px[i] = 0xFF000000 | (((v & 0x3FF) >>> 2) << 16) | ((((v >>> 10) & 0x3FF) >>> 2) << 8) | (((v >>> 20) & 0x3FF) >>> 2)
        }
    } else {
        for (let i = 0; i < px.length; i++) px[i] = px[i] | 0xFF000000
    }
}

function applyFrame(buf: ArrayBuffer, w: number, h: number, masks: Array<[number, number, number, number]>, peek: boolean) {
    const pixels = new Uint8ClampedArray(buf)
    if (clean === null || clean.length !== pixels.length || peek) {
        clean = pixels.slice()
    } else if (masks.length === 0) {
        clean.set(pixels)
    } else {
        const keep = new Uint8Array(w * h)
        for (const [x0, y0, x1, y1] of masks) {
            for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) keep.fill(1, y * w + Math.max(0, x0), y * w + Math.min(w, x1))
        }
        for (let y = 0; y < h; y++) {
            let x = 0
            while (x < w) {
                if (keep[y * w + x]) { x++; continue }
                let end = x
                while (end < w && !keep[y * w + end]) end++
                clean.set(pixels.subarray((y * w + x) * 4, (y * w + end) * 4), (y * w + x) * 4)
                x = end
            }
        }
    }
    if (video.width !== w || video.height !== h) { video.width = w; video.height = h }
    videoContext.putImageData(new ImageData(clean as any, w, h), 0, 0)
    video.videoWidth = w
    video.videoHeight = h
}

/** The marks next to a text (the picture of a button of the pad, an icon): the page keeps the plates off them. Looked for in the picture without our plates. */
function addStops(results: any[]): any[] {
    const w = video.videoWidth, h = video.videoHeight
    if (clean === null || w < 16 || h < 16 || clean.length !== w * h * 4) return results
    for (const item of results) {
        for (const segment of item.result.segments) {
            const rect = { x: segment.rect.x * w, y: segment.rect.y * h, w: segment.rect.w * w, h: segment.rect.h * h }
            const stops = findStops(clean, w, h, rect, segment.lineHeight * h, segment.background)
            if (stops.left !== undefined) segment.stopLeft = stops.left / w
            if (stops.right !== undefined) segment.stopRight = stops.right / w
        }
    }
    return results
}

function start() {
    engine?.stop()
    engine = new ElementsEngine({
        getVideo: () => (video.videoWidth > 0 ? video : null),
        getBox: () => ({ width: video.videoWidth || 1280, height: video.videoHeight || 800 }),
        getSettings: () => settings,
        getManualRegions: () => [],
        // After a change of the picture the engine reads more (a new screen), but not without a limit: a moving background (a video, a 3D scene) keeps changing it
        readDuty: () => (Date.now() < burstUntil ? Math.max(settings.readDuty ?? 0.25, Math.min(1, settings.burstDuty ?? 0.5)) : (settings.readDuty ?? 0.25)),
        // A few pictures a second and a wish to see the translation soon: the engine looks and reads again faster than it does for a video
        // The plates of the plugin that are in the picture (frames of the screen): rectangles in fractions of the picture
        getPlateRects: () => (liveSize.w > 0 && liveSize.h > 0 ? liveMasks.map(([x0, y0, x1, y1]) => ({ x: x0 / liveSize.w, y: y0 / liveSize.h, w: (x1 - x0) / liveSize.w, h: (y1 - y0) / liveSize.h })) : []),
        // A new screen is read by two readers at once (when the plugin asks for it: the game must not suffer)
        readConcurrency: () => (Date.now() < burstUntil ? Math.max(1, Math.min(2, settings.readers ?? 1)) : 1),
        speed: () => { const base = settings.speed ?? 0.7; return Date.now() < burstUntil ? Math.max(0.4, base * 0.7) : base },
        translate: async (text: string, target: string, source: string) => {
            const known = glossaryTranslation(text, source, target)
            if (known !== null) return known
            // The page answers at once with a draft (the local translation) and later, when the online one comes, with a better text: `better` is that second answer
            return new Promise<any>((resolve, reject) => {
                const id = nextTranslate++
                waiting.set(id, { resolve: (answer: any) => {
                    if (answer !== null && typeof answer === 'object' && answer.better === true) {
                        const better = new Promise<string | null>((done) => betterWaiting.set(id, done))
                        resolve({ text: answer.text, better })
                    } else resolve(answer)
                }, reject })
                ctx.postMessage({ type: 'translate', id, text, source, target })
            })
        },
        onResults: (results: any) => ctx.postMessage({ type: 'results', results: addStops(JSON.parse(JSON.stringify(results))) }),
        onStatus: (status: any) => ctx.postMessage({ type: 'status', status }),
        // The blocks the engine found (what Greenlight's debug view shows), only while the player wants to see them
        onFrames: (frames: any) => { if (settings.debug) ctx.postMessage({ type: 'frames', frames: JSON.parse(JSON.stringify(frames)) }) },
    } as any)
    engine.start()
    ctx.postMessage({ type: 'ready' })
}

// What the worker does, reported now and then (so the cost can be seen in the plugin log)
let appliedMs = 0
// The longest time the thread of the engine was not free in the last report (a long reading keeps the looks waiting)
let lagMax = 0
let lagLast = Date.now()
let scansBefore = 0
setInterval(() => { const now = Date.now(); lagMax = Math.max(lagMax, now - lagLast - 100); lagLast = now }, 100)
let stillFrames = 0
// When the page was last told that the picture changed much
let lastSceneMessage = 0
let appliedCount = 0
setInterval(() => {
    if (!engine) return
    ctx.postMessage({ type: 'perf', frames: appliedCount, applyMs: Math.round(appliedMs), scanMs: (engine as any)._scanTook, ocrReads: ocrStats.reads + ppocrStats.reads, ocrMs: ocrStats.ms + ppocrStats.ms, tessReads: ocrStats.reads, ppReads: ppocrStats.reads, detects: ppocrStats.detects, detMs: ppocrStats.detectMs, elements: engine.getCount(), cleanChecked: cleanChecks.checked, cleanChanged: cleanChecks.changed, stillFrames, ocrRemote: remoteStats.calls, ocrFailed: remoteStats.failures, lagMax, scans: (engine as any)._scans - scansBefore })
    lagMax = 0
    scansBefore = (engine as any)._scans
    cleanChecks.checked = 0
    cleanChecks.changed = 0
    appliedMs = 0
    appliedCount = 0
    ocrStats.reads = 0
    ppocrStats.reads = 0
    ppocrStats.ms = 0
    ppocrStats.detects = 0
    ppocrStats.detectMs = 0
    ocrStats.ms = 0
}, 5000)

// ---- Where gamescope puts the game's frame on the screen (stretched, fitted with bars, 1:1 ...): found by comparing the game's own frame with
// the base-plane screenshot of gamescope (the picture of the game as it is on the screen, without Steam's layer) ----
const MAP_CELLS_X = 160
const MAP_CELLS_Y = 100

function greyThumb(data: Uint8ClampedArray, w: number, h: number, tw: number, th: number): Float32Array {
    const out = new Float32Array(tw * th)
    for (let j = 0; j < th; j++) {
        const y0 = Math.floor(j * h / th), y1 = Math.max(y0 + 1, Math.floor((j + 1) * h / th))
        for (let i = 0; i < tw; i++) {
            const x0 = Math.floor(i * w / tw), x1 = Math.max(x0 + 1, Math.floor((i + 1) * w / tw))
            let sum = 0, n = 0
            const stepY = Math.max(1, Math.floor((y1 - y0) / 3)), stepX = Math.max(1, Math.floor((x1 - x0) / 3))
            for (let y = y0; y < y1; y += stepY) for (let x = x0; x < x1; x += stepX) { const o = (y * w + x) * 4; sum += data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114; n++ }
            out[j * tw + i] = sum / Math.max(1, n)
        }
    }
    return out
}

/** Where the game's frame lies on a screen of a given shape for a mode of the Steam setting "Scaling mode" (0 auto, 1 integer, 2 fit, 3 fill, 4 stretch): fractions of the screen. */
function areaForScaler(scaler: number, frame: number, screen: number): { name: string; x: number; y: number; w: number; h: number } {
    if (scaler === 4) return { name: 'stretch', x: 0, y: 0, w: 1, h: 1 }
    const wide = frame > screen
    if (scaler === 3) { const w = wide ? frame / screen : 1, h = wide ? 1 : screen / frame; return { name: 'fill', x: (1 - w) / 2, y: (1 - h) / 2, w, h } }
    const w = wide ? 1 : frame / screen, h = wide ? screen / frame : 1
    return { name: scaler === 0 ? 'auto(fit)' : (scaler === 1 ? 'integer(fit)' : 'fit'), x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

async function calibrateMapping(png: ArrayBuffer, aspect: number, scaler: number | null): Promise<any> {
    if (livePixels === null || liveSize.w < 16 || liveSize.h < 16) return { ok: false, reason: 'no frame' }
    const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }))
    const ow = bitmap.width, oh = bitmap.height
    // A screenshot of another shape than the screen (the picture of the game at its own size, or a stale one) says nothing about the screen: the mode of
    // the Steam setting is used then
    if (aspect > 0 && Math.abs(ow / oh - aspect) > 0.03 * aspect) {
        bitmap.close()
        if (scaler !== null && liveSize.w > 0) {
            const a = areaForScaler(scaler, liveSize.w / liveSize.h, aspect)
            return { ok: true, name: 'setting:' + a.name, area: { x: a.x, y: a.y, w: a.w, h: a.h }, frame: { w: liveSize.w, h: liveSize.h }, output: { w: ow, h: oh }, scores: ['screenshot ' + ow + 'x' + oh + ' not used'] }
        }
        return { ok: false, reason: 'screenshot ' + ow + 'x' + oh + ' does not fit the screen shape ' + aspect.toFixed(3) }
    }
    const c: any = new OffscreenCanvas(ow, oh)
    const cx = c.getContext('2d', { willReadFrequently: true })
    cx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const shot = cx.getImageData(0, 0, ow, oh).data
    const fw = liveSize.w, fh = liveSize.h
    const FW = 256, FH = Math.max(8, Math.round(256 * fh / fw))
    const frameThumb = greyThumb(livePixels, fw, fh, FW, FH)
    const shotThumb = greyThumb(shot, ow, oh, MAP_CELLS_X, MAP_CELLS_Y)
    const centered = (k: number) => ({ x: (ow - fw * k) / 2, y: (oh - fh * k) / 2, w: fw * k, h: fh * k })
    const fit = Math.min(ow / fw, oh / fh)
    const candidates: Array<{ name: string; x: number; y: number; w: number; h: number }> = [
        { name: 'stretch', x: 0, y: 0, w: ow, h: oh },
        { name: 'fit', ...centered(fit) },
        { name: 'fill', ...centered(Math.max(ow / fw, oh / fh)) },
    ]
    if (fw <= ow && fh <= oh) candidates.push({ name: 'native', ...centered(1) })
    const integer = Math.floor(fit)
    if (integer >= 2) candidates.push({ name: 'integer', ...centered(integer) })
    const scored = candidates.map((cand) => {
        let sum = 0
        for (let j = 0; j < MAP_CELLS_Y; j++) {
            const py = (j + 0.5) * oh / MAP_CELLS_Y
            for (let i = 0; i < MAP_CELLS_X; i++) {
                const px = (i + 0.5) * ow / MAP_CELLS_X
                let predicted = 0
                if (px >= cand.x && px < cand.x + cand.w && py >= cand.y && py < cand.y + cand.h) {
                    const u = Math.min(FW - 1, Math.max(0, Math.floor((px - cand.x) / cand.w * FW)))
                    const v = Math.min(FH - 1, Math.max(0, Math.floor((py - cand.y) / cand.h * FH)))
                    predicted = frameThumb[v * FW + u]
                }
                sum += Math.abs(shotThumb[j * MAP_CELLS_X + i] - predicted)
            }
        }
        return { ...cand, score: sum / (MAP_CELLS_X * MAP_CELLS_Y) }
    }).sort((a, b) => a.score - b.score)
    // Candidates that are the same place (the aspects are equal: stretch = fit) cannot be told apart, and do not need to be
    const best = scored[0]
    const other = scored.find((cand) => Math.abs(cand.x - best.x) > 3 || Math.abs(cand.y - best.y) > 3 || Math.abs(cand.w - best.w) > 3 || Math.abs(cand.h - best.h) > 3)
    const decisive = other === undefined || best.score < other.score * 0.8
    if (!decisive && scaler !== null) {
        const a = areaForScaler(scaler, fw / fh, ow / oh)
        return { ok: true, name: 'setting:' + a.name, area: { x: a.x, y: a.y, w: a.w, h: a.h }, frame: { w: fw, h: fh }, output: { w: ow, h: oh }, scores: scored.map((cand) => cand.name + ':' + cand.score.toFixed(1)) }
    }
    return { ok: decisive, name: best.name, area: { x: best.x / ow, y: best.y / oh, w: best.w / ow, h: best.h / oh }, frame: { w: fw, h: fh }, output: { w: ow, h: oh }, scores: scored.map((cand) => cand.name + ':' + cand.score.toFixed(1)) }
}

/** The modern reader (PP-OCR on onnxruntime-web): the engine uses it when it is loaded; when it is not, Tesseract reads as before. */
async function startModernReader(base: string) {
    try {
        ctx.importScripts(base + '/assets/ort/ort.wasm.min.js')
        const ort = ctx.ort
        ort.env.wasm.wasmPaths = base + '/assets/ort/'
        ort.env.wasm.numThreads = 1
        ort.env.wasm.proxy = false
        const [det, rec, keys] = await Promise.all([
            fetch(base + '/assets/ocr/det.onnx').then(r => r.arrayBuffer()),
            fetch(base + '/assets/ocr/rec.onnx').then(r => r.arrayBuffer()),
            fetch(base + '/assets/ocr/keys.txt').then(r => r.text()),
        ])
        await initPpocr(ort, new Uint8Array(det), new Uint8Array(rec), keys, { executionProviders: ['wasm'] })
        // English text read in a stylized font comes out with joined words ("TAKEIT"): a list of English words splits them
        if (settings.source === 'en') setWordList(await fetch(base + '/assets/ocr/words-en.txt').then(r => r.text()))
        setReaderMode('both')
        ctx.postMessage({ type: 'status', status: 'modern reader ready' })
    } catch (e) {
        ctx.postMessage({ type: 'error', message: 'modern reader failed (Tesseract reads): ' + e })
    }
}

/** The reader in a worker of its own: this worker only holds the models and answers the engine's requests that come through the port. */
async function startOcrWorker(base: string, port: MessagePort) {
    try {
        ctx.importScripts(base + '/assets/ort/ort.wasm.min.js')
        const ort = ctx.ort
        ort.env.wasm.wasmPaths = base + '/assets/ort/'
        ort.env.wasm.numThreads = 1
        ort.env.wasm.proxy = false
        const [det, rec, keys] = await Promise.all([
            fetch(base + '/assets/ocr/det.onnx').then(r => r.arrayBuffer()),
            fetch(base + '/assets/ocr/rec.onnx').then(r => r.arrayBuffer()),
            fetch(base + '/assets/ocr/keys.txt').then(r => r.text()),
        ])
        await initPpocr(ort, new Uint8Array(det), new Uint8Array(rec), keys, { executionProviders: ['wasm'] })
        setWordList(await fetch(base + '/assets/ocr/words-en.txt').then(r => r.text()))
        serveReader(port)
        port.postMessage({ type: 'ready' })
        ctx.postMessage({ type: 'status', status: 'reader worker ready' })
    } catch (e) {
        port.postMessage({ type: 'failed' })
        ctx.postMessage({ type: 'error', message: 'reader worker failed: ' + e })
    }
}

/** The engine side: the models are in the other worker; when it does not come up, or stops answering, this worker loads the models itself (as before). */
function startRemoteReader(base: string, ports: MessagePort[]) {
    let ready = false
    useRemoteReaders(ports, () => {
        ready = true
        setReaderMode('both')
        ctx.postMessage({ type: 'status', status: 'modern reader ready (own thread)' })
    }, () => {
        setReaderMode('tesseract')
        ctx.postMessage({ type: 'status', status: 'reader worker lost, the modern reader loads here' })
        void startModernReader(base)
    })
    setTimeout(() => { if (!ready) abandonRemoteReader() }, 45000)
}

ctx.onmessage = (event: MessageEvent) => {
    const m = event.data
    try {
        if (m.type === 'ocr-init') {
            void startOcrWorker(m.base, m.port)
        } else if (m.type === 'init') {
            settings = m.settings
            initEnv(m.base, m.scoutCode)
            start()
            // The modern reader knows English (and Chinese); for the other languages Tesseract reads, as before
            if (settings.reader !== 'classic' && settings.source === 'en') { if (m.ocrPorts && m.ocrPorts.length > 0) startRemoteReader(m.base, m.ocrPorts); else void startModernReader(m.base) }
        } else if (m.type === 'frame') {
            const t0 = performance.now()
            if (m.clean !== true) toRgba(m.buf, m.fmt || 'RGBA')
            // The game draws a still picture again and again (a menu): when not one pixel has changed, nothing is copied into the engine's picture
            if (livePixels !== null && m.clean !== true && m.peek !== true && !(m.masks && m.masks.length > 0) && liveSize.w === m.w && liveSize.h === m.h && livePixels.length === m.buf.byteLength) {
                const a = new Uint32Array(m.buf)
                const b = new Uint32Array(livePixels.buffer, livePixels.byteOffset, livePixels.length >> 2)
                let same = true
                for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { same = false; break } }
                if (same) {
                    stillFrames++
                    framesTaken++
                    ctx.postMessage({ type: 'ack', frames: framesTaken })
                    return
                }
            }
            const previousSmall = liveSmall
            // Frames of the screen (not of the game) hold our own plates: the engine's picture keeps the old pixels under them (see applyFrame), and a change of the picture is looked for in that one,
            // so that a plate that appears is not taken for a new screen
            const masked = !!(m.masks && m.masks.length > 0)
            const sceneCheck = () => {
                if (previousSmall === null || liveSmall === null || previousSmall.length !== liveSmall.length) return
                let sum = 0
                for (let i = 0; i < liveSmall.length; i++) sum += Math.abs(liveSmall[i] - previousSmall[i])
                if (sum / liveSmall.length > SCENE_DIFF) {
                    burstUntil = Date.now() + BURST_MS
                    // The page is told (at most once in 0.8 s): when the frames come from the screen it asks for a clean picture at once, to see what changed under the plates
                    if (Date.now() - lastSceneMessage > 800) { lastSceneMessage = Date.now(); ctx.postMessage({ type: 'scene' }) }
                }
            }
            if (!masked) {
                liveSmall = smallLuma(new Uint8ClampedArray(m.buf), m.w, m.h)
                sceneCheck()
            }
            liveMasks = m.masks || []
            liveSize = { w: m.w, h: m.h }
            livePixels = new Uint8ClampedArray(m.buf)
            applyFrame(m.buf, m.w, m.h, m.masks || [], m.peek === true)
            if (masked && clean !== null) {
                liveSmall = smallLuma(clean, m.w, m.h)
                sceneCheck()
            }
            appliedMs += performance.now() - t0
            appliedCount++
            framesTaken++
            ctx.postMessage({ type: 'ack', frames: framesTaken })
        } else if (m.type === 'clean') {
            // A picture of the game without our plates (PNG from gamescope): decoded here, off the page
            createImageBitmap(new Blob([m.png], { type: 'image/png' })).then((bitmap) => {
                const w = m.w, h = m.h
                const c: any = new OffscreenCanvas(w, h)
                const cx = c.getContext('2d', { willReadFrequently: true })
                // The picture is the size the game renders at: put it into the frame the way gamescope does (fit, centred)
                const k = Math.min(w / bitmap.width, h / bitmap.height)
                const dw = Math.round(bitmap.width * k), dh = Math.round(bitmap.height * k)
                if (dw !== w || dh !== h) { cx.fillStyle = '#000'; cx.fillRect(0, 0, w, h) }
                cx.drawImage(bitmap, Math.round((w - dw) / 2), Math.round((h - dh) / 2), dw, dh)
                bitmap.close()
                const data = cx.getImageData(0, 0, w, h).data
                const difference = cleanDifference(smallLuma(data, w, h))
                if (difference > CLEAN_MAX_DIFF) {
                    // Not the picture on screen (stale): not used
                    ctx.postMessage({ type: 'clean-rejected', difference: Math.round(difference) })
                    ctx.postMessage({ type: 'ack', frames: framesTaken, clean: true })
                } else if (cleanHasPlates(data, w, h)) {
                    // Our own plates are in it: it cannot tell what is under them
                    ctx.postMessage({ type: 'clean-rejected', difference: -1 })
                    ctx.postMessage({ type: 'ack', frames: framesTaken, clean: true })
                } else if (engine) {
                    // The clean picture does not replace the live one (it is scaled another way: everything would look changed); it only
                    // tells whether the text under the plates is still the same
                    engine.verifyAgainst(data, w, h).then((r: any) => {
                        cleanChecks.checked += r.checked
                        cleanChecks.changed += r.changed
                        // Under a plate the picture the engine reads still holds the old text: where it changed, the new pixels go in
                        if (r.rects.length > 0 && clean !== null && clean.length === data.length) {
                            for (const rect of r.rects) {
                                const x0 = Math.max(0, Math.floor((rect.x - 0.01) * w)), x1 = Math.min(w, Math.ceil((rect.x + rect.w + 0.01) * w))
                                const y0 = Math.max(0, Math.floor((rect.y - 0.01) * h)), y1 = Math.min(h, Math.ceil((rect.y + rect.h + 0.01) * h))
                                for (let y = y0; y < y1; y++) clean.set(data.subarray((y * w + x0) * 4, (y * w + x1) * 4), (y * w + x0) * 4)
                            }
                            videoContext.putImageData(new ImageData(clean as any, w, h), 0, 0)
                        }
                        ctx.postMessage({ type: 'ack', frames: framesTaken, clean: true })
                    })
                } else {
                    ctx.postMessage({ type: 'ack', frames: framesTaken, clean: true })
                }
            }).catch((error) => { ctx.postMessage({ type: 'error', message: 'clean decode: ' + error }); ctx.postMessage({ type: 'ack', frames: framesTaken }) })
        } else if (m.type === 'settings') {
            settings = m.settings
        } else if (m.type === 'translated') {
            const done = waiting.get(m.id)
            if (done) { waiting.delete(m.id); if (m.failed) done.reject(new Error('translation failed')); else done.resolve(m.better === true ? { text: m.text, better: true } : m.text) }
        } else if (m.type === 'better') {
            const done = betterWaiting.get(m.id)
            if (done) { betterWaiting.delete(m.id); done(m.text ?? null) }
        } else if (m.type === 'calibrate') {
            calibrateMapping(m.png, m.aspect || 0, typeof m.scaler === 'number' ? m.scaler : null).then((r) => ctx.postMessage({ type: 'mapping', ...r })).catch((e) => ctx.postMessage({ type: 'mapping', ok: false, reason: String(e) }))
        } else if (m.type === 'debug') {
            ctx.postMessage({ type: 'debug', lines: engine ? engine.getDebug() : [], count: engine ? engine.getCount() : 0 })
        } else if (m.type === 'stop') {
            engine?.stop()
            engine = null
        }
    } catch (error) {
        ctx.postMessage({ type: 'error', message: String(error && (error as any).stack || error) })
    }
}

self.addEventListener('error', (e) => ctx.postMessage({ type: 'error', message: 'worker error: ' + e.message }))
self.addEventListener('unhandledrejection', (e) => ctx.postMessage({ type: 'error', message: 'unhandled: ' + String((e as any).reason && (e as any).reason.stack || (e as any).reason) }))
