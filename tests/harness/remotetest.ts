// usage: node remotetest.cjs <png>   The reader in "another worker" (a channel in this process): the answers must be those of the local reader; a dead reader is given up.
import { initPpocr, ppocrDetectBoxes, ppocrRecognize, ppocrRemoteCount, remoteStats, serveReader, setRemoteTimeout, useRemoteReader, useRemoteReaders } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/ppocr'
const sharp = require('E:/Greenlight/node_modules/sharp')
const fs = require('fs'), path = require('path')
async function main() {
    const dir = process.env.PPOCR_DIR || (process.env.PPOCR_HOME || 'ppocr') + '/models'
    await initPpocr(require((process.env.PPOCR_HOME || 'ppocr') + '/node_modules/onnxruntime-node'), path.join(dir, 'det.onnx'), path.join(dir, 'rec.onnx'), fs.readFileSync(path.join(dir, 'keys.txt'), 'utf8'))
    const file = process.argv[2]
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
    const canvas = { width: info.width, height: info.height, getContext: () => ({ getImageData: () => ({ data: px.slice() }) }) }
    const local = await ppocrRecognize(canvas)
    const localBoxes = await ppocrDetectBoxes(px, info.width, info.height)
    console.log('local :', local.lines.length, 'lines,', localBoxes.length, 'boxes')

    // 1. the reader on the other end of a channel
    const channel = new MessageChannel()
    serveReader(channel.port2)
    let ready = false, failed = false
    useRemoteReader(channel.port1, () => { ready = true }, () => { failed = true })
    channel.port2.postMessage({ type: 'ready' })
    await new Promise(r => setTimeout(r, 50))
    const remote = await ppocrRecognize(canvas)
    const remoteBoxes = await ppocrDetectBoxes(px, info.width, info.height)
    const same = JSON.stringify(remote.lines.map(l => l.text)) === JSON.stringify(local.lines.map(l => l.text)) && remoteBoxes.length === localBoxes.length
    console.log('remote:', remote.lines.length, 'lines,', remoteBoxes.length, 'boxes; ready', ready, '; calls', remoteStats.calls, '; same as local:', same ? 'YES' : 'NO')
    if(!same || !ready || remoteStats.calls < 2) process.exitCode = 1

    // 2. a reader that does not answer: after three failed calls it is given up, and the next reading is done by the local models
    const dead = new MessageChannel()
    setRemoteTimeout(300)
    ready = false
    useRemoteReader(dead.port1, () => { ready = true }, () => { failed = true })
    dead.port2.postMessage({ type: 'ready' })
    await new Promise(r => setTimeout(r, 50))
    const started = Date.now()
    for(let i = 0; i < 3; i++) await ppocrRecognize(canvas)
    const after = await ppocrRecognize(canvas)
    console.log('dead  : failed callback', failed, '; failures', remoteStats.failures, '; reading after it:', after.lines.length, 'lines; took', Date.now() - started, 'ms', failed && after.lines.length === local.lines.length ? 'OK' : 'BAD')
    if(!failed || after.lines.length !== local.lines.length) process.exitCode = 1

    // 3. two readers: both are used, two readings go on at the same time, and when one is dead the other goes on
    const a = new MessageChannel(), b = new MessageChannel()
    serveReader(a.port2); serveReader(b.port2)
    setRemoteTimeout(20000)
    let readyCount = 0, poolFailed = false
    useRemoteReaders([a.port1, b.port1], () => { readyCount++ }, () => { poolFailed = true })
    a.port2.postMessage({ type: 'ready' }); b.port2.postMessage({ type: 'ready' })
    await new Promise(r => setTimeout(r, 50))
    const t0 = Date.now()
    const both = await Promise.all([ppocrRecognize(canvas), ppocrRecognize(canvas)])
    const together = Date.now() - t0
    console.log('pool  : readers', ppocrRemoteCount(), '; two readings together', together, 'ms; lines', both.map(r => r.lines.length).join('/'), both.every(r => r.lines.length === local.lines.length) ? 'OK' : 'BAD')
    if(ppocrRemoteCount() !== 2 || !both.every(r => r.lines.length === local.lines.length)) process.exitCode = 1
    // one reader dies (it says so): the other one still reads
    a.port2.postMessage({ type: 'failed' })
    await new Promise(r => setTimeout(r, 50))
    const one = await ppocrRecognize(canvas)
    console.log('pool  : after one failed: readers', ppocrRemoteCount(), '; reading', one.lines.length, 'lines; all given up:', poolFailed, one.lines.length === local.lines.length && ppocrRemoteCount() === 1 && !poolFailed ? 'OK' : 'BAD')
    if(one.lines.length !== local.lines.length || ppocrRemoteCount() !== 1 || poolFailed) process.exitCode = 1
    b.port2.postMessage({ type: 'failed' })
    await new Promise(r => setTimeout(r, 50))
    console.log('pool  : after both failed: all given up:', poolFailed, poolFailed ? 'OK' : 'BAD')
    if(!poolFailed) process.exitCode = 1
    process.exit()
}
main()
