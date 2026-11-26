import re
src=open('E:/Greenlight/packages/desktop/renderer/lib/translator/scout.ts',encoding='utf-8').read()
s=src
s=s.replace("const CELL = 4","export let DBG: ((tag: string, part: any, info?: any) => void) | null = null\nexport function setDbg(f: any) { DBG = f }\nconst CELL = 4",1)
s=s.replace("            return h >= MIN_HEIGHT_CELLS && w >= MIN_WIDTH_CELLS && w >= h && h * CELL <= MAX_BLOCK_HEIGHT * height\n","            const ok = h >= MIN_HEIGHT_CELLS && w >= MIN_WIDTH_CELLS && w >= h && h * CELL <= MAX_BLOCK_HEIGHT * height\n            if(!ok){ DBG?.('LINE-FILTER', part, { w, h }) }\n            return ok\n",1)
s=s.replace("                continue\n            }\n\n            // A single row is much wider","                DBG?.('SIZE/FILL', part, { w, h, fill: +fill.toFixed(3) })\n                continue\n            }\n\n            // A single row is much wider",1)
s=s.replace("            if(single && w < h * MIN_ASPECT){\n                continue","            if(single && w < h * MIN_ASPECT){\n                DBG?.('ASPECT', part, { w, h, aspect: +(w / h).toFixed(2) })\n                continue",1)
s=s.replace("            if((ratio < need && !(onShare >= BUSY_ON_SHARE && ratio >= BUSY_RATIO)) || onShare < minOn){\n                continue","            if((ratio < need && !(onShare >= BUSY_ON_SHARE && ratio >= BUSY_RATIO)) || onShare < minOn){\n                DBG?.('RING/ONSHARE', part, { w, h, ratio: +ratio.toFixed(2), need, onShare: +onShare.toFixed(2), minOn: +minOn.toFixed(2) })\n                continue",1)
s=s.replace("    return { blocks: kept.filter(block => block.score >= floor)","    for(const b of kept){ if(b.score < floor){ DBG?.('SCORE', { x0: b.x * width / CELL, y0: b.y * height / CELL, x1: (b.x + b.w) * width / CELL, y1: (b.y + b.h) * height / CELL, polarity: b.polarity }, { score: Math.round(b.score), floor: Math.round(floor) }) } }\n    return { blocks: kept.filter(block => block.score >= floor)",1)
open('dbg/scout.ts','w',encoding='utf-8').write(s)
import shutil; shutil.copy('E:/Greenlight/packages/desktop/renderer/lib/translator/ink.ts','dbg/ink.ts')
print(s.count('DBG?.'))
