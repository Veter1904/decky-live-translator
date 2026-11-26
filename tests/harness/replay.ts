import { install, video } from './realcanvas'
import { setReaderMode } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ocr'
import { initPpocr, setWordList } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ppocr'
install()
import ElementsEngine from 'E:/Greenlight/packages/desktop/renderer/lib/translator/elements'
const sharp = require('E:/Greenlight/node_modules/sharp')

const seconds = parseInt(process.argv[2] || '40')
const files = process.argv.slice(3)
const t0 = Date.now()
const log = (m: string) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's  ' + m)

async function main() {
    ;(globalThis as any).DLTDBG = !!process.env.DLTDBG
    if(process.env.READER && process.env.READER !== 'tesseract'){
        const fs2 = require('fs'), path2 = require('path'); const dir = (process.env.PPOCR_HOME || 'ppocr') + '/models'
        await initPpocr(require((process.env.PPOCR_HOME || 'ppocr') + '/node_modules/onnxruntime-node'), path2.join(dir, 'det.onnx'), path2.join(dir, 'rec.onnx'), fs2.readFileSync(path2.join(dir, 'keys.txt'), 'utf8'))
        if (!process.env.NOWORDS) setWordList(require('fs').readFileSync('E:/decky-live-translator/assets/ocr/words-en.txt', 'utf8'))
        setReaderMode(process.env.READER as any)
    }
    const frames: Uint8ClampedArray[] = []
    for(const file of files){
        const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        video.videoWidth = info.width
        video.videoHeight = info.height
        frames.push(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length))
    }
    video.data = frames[0]

    let current: Map<number, string> = new Map()
    let changes = 0
    let lastSet = ''
    const engine = new ElementsEngine({
        getVideo: () => video,
        getBox: () => ({ width: video.videoWidth, height: video.videoHeight }),
        getSettings: () => ({ fit: 'default', source: 'en', target: 'uk', color: 'light', panels: true }),
        getManualRegions: () => [],
        translate: async (text) => { await new Promise(r => setTimeout(r, 60)); return 'UA[' + text + ']' },
        onResults: (results) => { if(process.env.SEGS && results.length !== (globalThis as any)._n){ (globalThis as any)._n = results.length; results.forEach((r: any) => r.result.segments.forEach((s: any) => console.log('SEG', JSON.stringify(s.original), '->', JSON.stringify(s.translated), 'x', s.rect.x.toFixed(3), 'y', s.rect.y.toFixed(3), 'w', s.rect.w.toFixed(3), 'h', s.rect.h.toFixed(3), 'lh', s.lineHeight.toFixed(3), 'bg', s.background, 'fg', s.foreground))) }
            const set = results.map(r => r.result.segments.map(s => s.translated).join('/')).sort().join(' | ')
            if(set !== lastSet){ changes++; lastSet = set }
            current = new Map(results.map(r => [r.id, r.result.segments.map(s => s.original).join(' / ')]))
        },
        onStatus: (s) => log('status ' + s),
    })
    engine.start()

    let step = 0
    const timer = setInterval(() => {
        step++
        video.data = frames[step % frames.length]
        log('frame ' + (step % frames.length) + '  elements ' + engine.getCount() + '  shown ' + current.size + '  changes so far ' + changes)
    }, 1000)
    setTimeout(() => {
        clearInterval(timer)
        log('--- final: ' + current.size + ' elements shown, ' + changes + ' changes of the shown set')
        engine.getDebug().forEach(line => console.log('   ' + line))
        if(process.env.PIECES){ (engine as any)._lastPieces.forEach((b: any) => console.log('   piece', b.polarity, b.role, 'x', b.x.toFixed(3), 'y', b.y.toFixed(3), 'w', b.w.toFixed(3), 'h', b.h.toFixed(3), 'score', Math.round(b.score))) }
        (engine as any)._elements.forEach((e: any) => console.log('INK', e.id, e.state, '', JSON.stringify(e.segments.map((s: any) => [s.original, s.ink, s.background, s.foreground]))))
        engine.stop()
        process.exit(0)
    }, seconds * 1000)
}
main()
