// Copies the engine of the Greenlight translator (MIT, branch `deck`) into engine/vendor and patches the few places that
// need a page: `document.createElement('canvas')` -> OffscreenCanvas, `document.hidden` -> false, asset URLs and the scout
// worker come from ../env. Also copies the Tesseract assets and the scout worker into assets/ (git-ignored, ~12 MB).
const fs = require('fs'), path = require('path')
const GREENLIGHT = process.env.GREENLIGHT || 'E:/Greenlight/packages/desktop/renderer'
const SRC = path.join(GREENLIGHT, 'lib/translator')
const OUT = path.join(__dirname, '..', 'engine', 'vendor')
const ASSETS = path.join(__dirname, '..', 'assets')
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(path.join(ASSETS, 'scout'), { recursive: true })

const header = "// Copied from Greenlight (MIT) by scripts/sync-engine.cjs and patched for a worker. Do not edit here.\n"
function patch(name, text) {
    text = text.replace(/document\.createElement\('canvas'\)/g, 'makeCanvas()').replace(/document\.hidden/g, 'false')
    const imports = []
    if (/makeCanvas\(\)/.test(text)) imports.push('makeCanvas')
    if (name === 'ocr.ts') {
        text = text.replace("return new URL('/tesseract/' + path, window.location.href).href", "return envAssetUrl('tesseract/' + path)").replace('workerBlobURL: false', 'workerBlobURL: true')
        imports.push('assetUrl as envAssetUrl')
    }
    if (name === 'elements.ts') {
        text = text.replace("new Worker(new URL('/scout/worker.js', window.location.href).href)", 'makeScoutWorker()')
        imports.push('makeScoutWorker')
    }
    if (/window\.|document\./.test(text.replace(/\/\/.*$/gm, ''))) console.warn('WARNING: ' + name + ' still touches window/document')
    return header + (imports.length ? "import { " + imports.join(', ') + " } from '../env'\n" : '') + text
}
for (const f of ['elements', 'engine', 'geometry', 'ink', 'scout', 'uiwords', 'ocr', 'ppocr', 'readererrors']) {
    fs.writeFileSync(path.join(OUT, f + '.ts'), patch(f + '.ts', fs.readFileSync(path.join(SRC, f + '.ts'), 'utf8')))
}
fs.copyFileSync(path.join(GREENLIGHT, 'public/scout/worker.js'), path.join(ASSETS, 'scout/worker.js'))
fs.cpSync(path.join(GREENLIGHT, 'public/tesseract'), path.join(ASSETS, 'tesseract'), { recursive: true })
// The local translator (Bergamot / Marian in WASM, MPL-2.0): the worker and the engine (the models are downloaded by the backend)
fs.mkdirSync(path.join(ASSETS, 'bergamot'), { recursive: true })
for (const f of ['translator-worker.js', 'bergamot-translator-worker.js', 'bergamot-translator-worker.wasm']) {
    fs.copyFileSync(path.join(GREENLIGHT, 'public/bergamot/worker', f), path.join(ASSETS, 'bergamot', f))
}
fs.writeFileSync(path.join(ASSETS, 'bergamot', 'README.md'), 'From the npm package @browsermt/bergamot-translator 0.4.9 (MPL-2.0, https://github.com/browsermt/bergamot-translator), via Greenlight public/bergamot.' + String.fromCharCode(10))
console.log('synced')
