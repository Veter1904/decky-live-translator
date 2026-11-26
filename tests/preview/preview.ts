// Draws the plates of a recording (plates.jsonl) over its frame with the real layout code of the plugin (src/render.ts), in a browser.
// Build:  npx esbuild tests/preview/preview.ts --bundle --format=iife --outfile=tests/preview/preview.js
// Serve the folder of a recording with preview.html + preview.js next to f000.png... and open  preview.html?n=12&note=8
import { dropCovered, linesOf, nextAbove, nextBelow, segmentStyle, sideLimits, sizeCaps } from '../../src/render'

async function main() {
    const q = new URLSearchParams(location.search)
    const n = Number(q.get('n') || 0), noteIndex = Number(q.get('note') || -1)
    const text = await (await fetch('plates.jsonl')).text()
    const notes = text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const note = notes[noteIndex >= 0 ? noteIndex : notes.length - 1]
    const W = 1280, H = 800
    const root = document.getElementById('stage') as HTMLDivElement
    root.style.cssText = `position:relative;width:${W}px;height:${H}px;background:url(f${String(n).padStart(3, '0')}.png) no-repeat;background-size:${W}px ${H}px;overflow:hidden;font-family:"Noto Sans",Arial,sans-serif`
    // the Steam UI is 854 x 534 CSS px on the 1280 x 800 screen (scale 1.5): the plates are laid out in those units
    const vp = { width: W / 1.5, height: H / 1.5 }
    const layer = document.createElement('div')
    layer.style.cssText = `position:absolute;left:0;top:0;width:${vp.width}px;height:${vp.height}px;transform:scale(1.5);transform-origin:0 0`
    root.appendChild(layer)
    const items: any[] = []
    for (const r of note.results) r.segments.forEach((g: any, i: number) => items.push({ key: r.id + '-' + i, segment: { original: g.o, translated: g.t, rect: g.r, lineHeight: g.lh ?? Math.min(g.r.h, 0.024), background: g.bg, foreground: g.fg, centered: !!g.c, shownAt: 0 }, rect: g.r }))
    const worth = items.filter((i) => i.segment.translated.trim() !== '' && i.segment.translated.trim().toLowerCase() !== i.segment.original.trim().toLowerCase())
    const shown = dropCovered(worth)
    const all = shown.map((i: any) => i.segment)
    const own = shown.map((item: any, index: number) => segmentStyle(item.segment, vp, true, 26, 1, nextBelow(all, index), sideLimits(all, index), undefined, undefined, nextAbove(all, index)))
    const caps = sizeCaps(shown.map((item: any) => item.segment.lineHeight), own.map((st: any) => Number(String(st.fontSize).replace('px', '')) || 14))
    shown.forEach((item: any, index: number) => {
        const [r, g, b] = item.segment.background
        const pad = Math.max(6, item.segment.rect.h * vp.height * 0.35)
        const cover = document.createElement('div')
        Object.assign(cover.style, { position: 'absolute', left: item.segment.rect.x * vp.width - pad + 'px', top: item.segment.rect.y * vp.height - 5 + 'px', width: item.segment.rect.w * vp.width + 2 * pad + 8 + 'px', height: item.segment.rect.h * vp.height + 10 + 'px', background: `rgb(${r}, ${g}, ${b})`, borderRadius: '4px' })
        layer.appendChild(cover)
        const el = document.createElement('div')
        Object.assign(el.style, { position: 'absolute', boxSizing: 'border-box', display: 'flex', alignItems: 'center', padding: '2px 8px', borderRadius: '5px', lineHeight: '1.2', fontWeight: linesOf(item.segment, vp) > 1 ? '500' : '600', overflowWrap: 'break-word' }, segmentStyle(item.segment, vp, true, 26, 1, nextBelow(all, index), sideLimits(all, index), undefined, caps[index], nextAbove(all, index)) as any)
        el.textContent = item.segment.translated
        layer.appendChild(el)
    })
    document.title = 'preview ' + shown.length + ' plates'
}
main()
