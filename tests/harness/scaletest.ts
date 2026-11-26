// usage: node scaletest.cjs <png> x y w h   Reads a small piece of a picture at different enlargements / resampling kernels with the modern reader.
import { initPpocr, ppocrRecognize, setWordList } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ppocr'
const sharp = require('E:/Greenlight/node_modules/sharp')
const fs = require('fs'), path = require('path')
async function main() {
    const dir = (process.env.PPOCR_HOME || 'ppocr') + '/models'
    await initPpocr(require((process.env.PPOCR_HOME || 'ppocr') + '/node_modules/onnxruntime-node'), path.join(dir, 'det.onnx'), path.join(dir, 'rec.onnx'), fs.readFileSync(path.join(dir, 'keys.txt'), 'utf8'))
    setWordList(fs.readFileSync('E:/decky-live-translator/assets/ocr/words-en.txt', 'utf8'))
    const [file, x, y, w, h] = [process.argv[2], ...process.argv.slice(3, 7).map(Number)]
    for (const kernel of (process.env.KERNELS || 'nearest,linear,cubic,lanczos3').split(',')) {
        for (const scale of (process.env.SCALES || '1,2,3,4,6').split(',').map(Number)) {
            let img = sharp(file).extract({ left: x, top: y, width: w, height: h })
            if (scale > 1) img = img.resize(Math.round(w * scale), Math.round(h * scale), { kernel })
            if (process.env.SHARP) img = img.sharpen({ sigma: 1 })
            const mode = process.env.MODE || 'plain'
            if (mode === 'green') img = img.extractChannel('green').toColourspace('b-w').normalise()
            else if (mode === 'grey') img = img.greyscale().normalise()
            else if (mode === 'inv') img = img.greyscale().normalise().negate()
            else if (mode === 'stretch') img = img.normalise({ lower: 2, upper: 98 })
            else if (mode === 'clahe') img = img.clahe({ width: 16, height: 16, maxSlope: 3 })
            const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
            const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
            const canvas = { width: info.width, height: info.height, getContext: () => ({ getImageData: () => ({ data: px.slice() }) }) }
            const r = await ppocrRecognize(canvas)
            console.log(kernel.padEnd(9), 'x' + scale, '->', r.lines.map((l) => l.text).join(' | '))
        }
    }
}
main()
