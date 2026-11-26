// Stands in for 'tesseract.js' in the browser build: the real reader of Node, with the language file on disk.
// It also says when a method of the reader is used after the reader was terminated.
const real = require('E:/Greenlight/node_modules/tesseract.js')
const sharp = require('E:/Greenlight/node_modules/sharp')

const where = () => String(new Error().stack).split('\n').slice(3, 8).map(line => line.trim().replace('E:\\Greenlight\\packages\\desktop\\renderer\\lib\\translator\\', '')).join(' | ')

export async function createWorker(lang: any, n: any, _opts: any) {
    const worker = await real.createWorker(lang, n, { langPath: 'E:/Greenlight/packages/desktop/renderer/public/tesseract/lang', gzip: false, cacheMethod: 'none' })
    let terminated = false
    const terminate = worker.terminate.bind(worker)
    worker.terminate = async () => { terminated = true; return terminate() }
    for(const name of ['setParameters', 'initialize', 'reinitialize', 'loadLanguage']){
        const original = worker[name] && worker[name].bind(worker)
        if(original){
            worker[name] = (...args: any[]) => {
                if(terminated){ console.log('CALL AFTER TERMINATE:', name, where()) }
                return original(...args)
            }
        }
    }
    const recognize = worker.recognize.bind(worker)
    let counter = 0
    worker.recognize = async (img: any, o: any, out: any) => {
        if(terminated){ console.log('CALL AFTER TERMINATE: recognize', where()) }
        let buffer: any = img
        if(img && img.data && img.width){
            buffer = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 4 } }).png().toBuffer()
        }
        const result = await recognize(buffer, o, out)
        if(process.env.OCRDUMP){
            const n = ++counter
            try {
                require('fs').writeFileSync(process.env.OCRDUMP + '/img_' + String(n).padStart(3, '0') + '.png', buffer)
                console.log('OCR', String(n).padStart(3, '0'), img && img.width ? img.width + 'x' + img.height : '', JSON.stringify(String(result.data.text).trim().slice(0, 60)), Math.round(result.data.confidence))
            } catch(e) { console.log('dump failed', e) }
        }
        return result
    }
    return worker
}
