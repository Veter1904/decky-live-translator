// usage: node ppocrtest.cjs <png>...   Prints what the modern reader (PP-OCR, onnxruntime-node) reads in the whole picture.
import { initPpocr, ppocrRecognize } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ppocr'
const sharp = require('E:/Greenlight/node_modules/sharp')
const fs = require('fs'), path = require('path')
async function main() {
    const dir = process.env.PPOCR_DIR || (process.env.PPOCR_HOME || 'ppocr') + '/models'
    await initPpocr(require((process.env.PPOCR_HOME || 'ppocr') + '/node_modules/onnxruntime-node'), path.join(dir, 'det.onnx'), path.join(dir, 'rec.onnx'), fs.readFileSync(path.join(dir, 'keys.txt'), 'utf8'))
    for (const file of process.argv.slice(2)) {
        const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
        const canvas = { width: info.width, height: info.height, getContext: () => ({ getImageData: () => ({ data: px }) }) }
        const r = await ppocrRecognize(canvas)
        console.log(path.basename(file), '->', r.lines.map((l) => l.text).join(' | '))
    }
}
main()
