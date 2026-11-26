import { analyseScreen, setDbg } from './dbg/scout'
const sharp = require('E:/Greenlight/node_modules/sharp')
// usage: node scoutdbg.js <png> x0,y0,x1,y1 [x0,y0,x1,y1 ...]   (pixel boxes of the texts to explain)
;(async () => {
    const { data, info } = await sharp(process.argv[2]).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const boxes = process.argv.slice(3).map(s => s.split(',').map(Number))
    const w = info.width, h = info.height
    setDbg((tag: string, part: any, extra: any) => {
        const px = { x0: part.x0 * 4, y0: part.y0 * 4, x1: part.x1 * 4, y1: part.y1 * 4 }
        for(const [bx0, by0, bx1, by1] of boxes){
            const ox = Math.min(px.x1, bx1) - Math.max(px.x0, bx0), oy = Math.min(px.y1, by1) - Math.max(px.y0, by0)
            if(ox > 0 && oy > 0 && ox * oy > 0.3 * (bx1 - bx0) * (by1 - by0)){
                console.log(tag.padEnd(14), part.polarity, JSON.stringify(px), JSON.stringify(extra)); return
            }
        }
    })
    const r = analyseScreen(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w, h, ['light', 'dark'], 30)
    console.log('blocks:', r.blocks.map(b => `${b.polarity[0]}(${Math.round(b.x * w)},${Math.round(b.y * h)},${Math.round(b.w * w)},${Math.round(b.h * h)} s${Math.round(b.score)})`).join(' '))
})()
