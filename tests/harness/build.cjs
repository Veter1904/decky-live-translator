const path = require('path')
// GREENLIGHT: a Greenlight checkout (the engine tests import its files); PPOCR_NODE: onnxruntime-node for the reader tests. Both are for the author's machine; the i18n test needs neither.
const GREENLIGHT = process.env.GREENLIGHT || 'E:/Greenlight'
let esbuild
try { esbuild = require('esbuild') } catch (e) { esbuild = require(GREENLIGHT + '/node_modules/esbuild') }
esbuild.build({
    entryPoints: [path.join(__dirname, (process.env.ENTRY || 'replay') + '.ts')], bundle: true, platform: 'node', outfile: path.join(__dirname, (process.env.ENTRY || 'replay') + '.cjs'), logLevel: 'error',
    external: [GREENLIGHT + '/node_modules/tesseract.js', GREENLIGHT + '/node_modules/sharp', process.env.PPOCR_NODE || (process.env.PPOCR_HOME || 'ppocr') + '/node_modules/onnxruntime-node'],
    plugins: [{ name: 'shim', setup(build) {
        build.onResolve({ filter: /^tesseract\.js$/ }, () => ({ path: path.join(__dirname, 'ocrshim.ts') }))
    } }],
}).then(() => console.log('built'))
