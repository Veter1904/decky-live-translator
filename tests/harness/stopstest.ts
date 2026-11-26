import { findStops } from '../../engine/obstacles'
const sharp = require((process.env.GREENLIGHT || 'E:/Greenlight') + '/node_modules/sharp')
const fs = require('fs')
// usage: node stopstest.cjs <frame.png> <plates.json: [{o, r:{x,y,w,h}, lh, bg}]> : prints where the marks next to each text are
async function main() {
    const { data, info } = await sharp(process.argv[2]).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
    for (const s of JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))) {
        const rect = { x: s.r.x * info.width, y: s.r.y * info.height, w: s.r.w * info.width, h: s.r.h * info.height }
        const stops = findStops(rgba, info.width, info.height, rect, s.lh * info.height, s.bg)
        console.log(JSON.stringify(s.o.slice(0, 34)).padEnd(38), 'x', Math.round(rect.x), '-', Math.round(rect.x + rect.w), ' left', stops.left === undefined ? '-' : Math.round(stops.left), ' right', stops.right === undefined ? '-' : Math.round(stops.right))
    }
}
main()
