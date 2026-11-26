p = 'dbg/scout.ts'
s = open(p, encoding='utf-8').read()
marker = '        const lines = candidates.filter((part) => {'
add = '        candidates.forEach(c => DBG?.("CANDIDATE", c, { w: c.x1 - c.x0, h: c.y1 - c.y0 }))\n'
assert marker in s
s = s.replace(marker, add + marker, 1)
open(p, 'w', encoding='utf-8').write(s)

s = open(p, encoding='utf-8').read()
old = '        for(const part of mergeLines(lines, rows)){'
new = '        const mergedParts = mergeLines(lines, rows)\n        mergedParts.forEach(c => DBG?.("MERGED", c, { w: c.x1 - c.x0, h: c.y1 - c.y0, fill: +(c.ink / ((c.x1 - c.x0) * (c.y1 - c.y0) * CELL * CELL)).toFixed(3) }))\n        for(const part of mergedParts){'
assert old in s
s = s.replace(old, new, 1)
s = s.replace("            blocks.push({ ...block,", "            DBG?.('ACCEPT', part, { ratio: +ratio.toFixed(2), onShare: +onShare.toFixed(2) })\n            blocks.push({ ...block,", 1)
open(p, 'w', encoding='utf-8').write(s)

s = open(p, encoding='utf-8').read()
old = "            if((ratio < need && !busy) || onShare < minOn){\n                continue"
new = "            if((ratio < need && !busy) || onShare < minOn){\n                DBG?.('RING/ONSHARE', part, { w, h, ratio: +ratio.toFixed(2), need, busy, onShare: +onShare.toFixed(2), minOn: +minOn.toFixed(2) })\n                continue"
if old in s:
    s = s.replace(old, new, 1)
else:
    print('RING patch not applied')
open(p, 'w', encoding='utf-8').write(s)
