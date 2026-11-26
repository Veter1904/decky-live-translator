// Bundles the engine worker (engine/worker.ts + vendor + tesseract.js) into assets/engine-worker.js
const path = require('path')
const esbuild = require('esbuild')
esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'engine', 'worker.ts')],
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', minify: true, legalComments: 'none',
    outfile: path.join(__dirname, '..', 'assets', 'engine-worker.js'), logLevel: 'info', define: { 'process.env.NODE_ENV': '"production"' },
}).catch(() => process.exit(1))
