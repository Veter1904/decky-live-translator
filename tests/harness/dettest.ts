// usage: node dettest.cjs <png> x y w h   How many lines of text the detector finds in a region at different sizes of its input.
import { initPpocr, ppocrDetectBoxes, setDetMaxSide } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ppocr'
const sharp = require('E:/Greenlight/node_modules/sharp')
const fs = require('fs'), path = require('path')
async function main() {
    const dir = (process.env.PPOCR_HOME || 'ppocr') + '/models'
    await initPpocr(require((process.env.PPOCR_HOME || 'ppocr') + '/node_modules/onnxruntime-node'), path.join(dir, 'det.onnx'), path.join(dir, 'rec.onnx'), fs.readFileSync(path.join(dir, 'keys.txt'), 'utf8'))
    const [file, rx, ry, rw, rh] = [process.argv[2], ...process.argv.slice(3, 7).map(Number)]
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
    for (const side of (process.env.SIDES || '960,1280,1600').split(',').map(Number)) {
        setDetMaxSide(side)
        const t0 = Date.now()
        const boxes = await ppocrDetectBoxes(px, info.width, info.height)
        const ms = Date.now() - t0
        const inside = boxes.filter((b) => b.x + b.w / 2 >= rx && b.x + b.w / 2 <= rx + rw && b.y + b.h / 2 >= ry && b.y + b.h / 2 <= ry + rh)
        console.log('side', side, '-> all', boxes.length, 'boxes,', ms, 'ms; in the region:', inside.length, inside.sort((a, b) => a.y - b.y).slice(0, 14).map((b) => `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)}x${Math.round(b.h)}`).join(' '))
    }
}
main()
