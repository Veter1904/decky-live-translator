// Layout of the plates (position, size, colours of a translation over the original text).
// Ported from Greenlight's translatoroverlay.tsx (MIT); the text measuring uses OffscreenCanvas.
import type { CSSProperties } from "react";

export interface Region { x: number; y: number; w: number; h: number }
export interface TranslatedSegment {
  original: string; translated: string; rect: Region; lineHeight: number;
  background: [number, number, number]; foreground: string; centered: boolean; shownAt?: number;
}
export interface TranslatorResult { original: string; translated: string; segments: TranslatedSegment[]; bounds?: Region }
export interface ElementResult { id: number; role: string; result: TranslatorResult }

let measureContext: any

function overlapShare(a: Region, b: Region): number {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return (width * height) / Math.max(1e-9, Math.min(a.w * a.h, b.w * b.h));
}

export function dropCovered<T extends { rect: Region; shownAt?: number }>(segments: T[]): T[] {
  // The biggest piece of text first (a paragraph covers the bits of it that other readings found: "le artificial intelligence, known as"); among equal ones the newer
  // reading: a piece that lies mostly inside a kept bigger one is not drawn
  const area = (segment: T) => segment.rect.w * segment.rect.h;
  const order = segments.map((segment, index) => ({ segment, index })).sort((a, b) => area(b.segment) - area(a.segment) || (b.segment.shownAt ?? 0) - (a.segment.shownAt ?? 0) || a.index - b.index);
  const kept: Array<{ segment: T; index: number }> = [];
  for (const item of order) {
    if (!kept.some((other) => overlapShare(item.segment.rect, other.segment.rect) > 0.5)) kept.push(item);
  }
  return kept.sort((a, b) => a.index - b.index).map((item) => item.segment);
}

// How many rows a text takes when it is wrapped at `width` (a word is never cut)
function wrapRows(text: string, size: number, width: number): number {
    let rows = 1
    let line = 0
    const space = textWidth(' ', size)

    for(const word of text.split(/\s+/)){
        const length = textWidth(word, size)
        if(line > 0 && line + space + length > width){
            rows++
            line = length
        } else {
            line = line === 0 ? length : line + space + length
        }
    }
    return rows
}

function textWidth(text: string, size: number): number {
    if(measureContext === undefined){
        measureContext = new OffscreenCanvas(1, 1).getContext('2d') as any
    }

    if(measureContext === null){
        return text.length * size * 0.55
    }

    measureContext.font = '600 ' + size + 'px "Motiva Sans", "Noto Sans", Arial, sans-serif'
    return measureContext.measureText(text).width
}

/** Position, size and colours of the translation of one piece of text, so it looks like the interface it replaces. */
/** Where the next piece of text below this one starts (fraction of the height), so the translation does not run over it. */
export function nextBelow(segments: TranslatedSegment[], index: number): number | undefined {
    const segment = segments[index]
    let best: number | undefined
    segments.forEach((other, i) => {
        const overlapsInX = other.rect.x < segment.rect.x + segment.rect.w + 0.1 && other.rect.x + other.rect.w > segment.rect.x - 0.1
        if(i !== index && overlapsInX && other.rect.y > segment.rect.y + segment.rect.h * 0.4 && (best === undefined || other.rect.y < best)){
            best = other.rect.y
        }
    })
    return best
}

/** Where the piece of text above this one ends (fraction of the height): the plate does not reach up into it. */
export function nextAbove(segments: TranslatedSegment[], index: number): number | undefined {
    const segment = segments[index]
    let best: number | undefined
    segments.forEach((other, i) => {
        const overlapsInX = other.rect.x < segment.rect.x + segment.rect.w + 0.1 && other.rect.x + other.rect.w > segment.rect.x - 0.1
        const bottom = other.rect.y + other.rect.h
        if(i !== index && overlapsInX && other.rect.y < segment.rect.y - segment.rect.h * 0.4 && bottom <= segment.rect.y + segment.rect.h * 0.6 && (best === undefined || bottom > best)){
            best = bottom
        }
    })
    return best
}

/** The nearest piece of text on the same row to the left and to the right (fractions of the width): the translation stays between them. */
export function sideLimits(segments: TranslatedSegment[], index: number): { left?: number; right?: number } {
    const segment = segments[index]
    const limits: { left?: number; right?: number } = {}
    segments.forEach((other, i) => {
        if(i === index){ return }
        const top = Math.max(segment.rect.y, other.rect.y)
        const bottom = Math.min(segment.rect.y + segment.rect.h, other.rect.y + other.rect.h)
        if(bottom - top < Math.min(segment.rect.h, other.rect.h) * 0.4){ return }

        if(other.rect.x >= segment.rect.x + segment.rect.w * 0.5 && other.rect.x + other.rect.w > segment.rect.x + segment.rect.w){
            limits.right = limits.right === undefined ? other.rect.x : Math.min(limits.right, other.rect.x)
        } else if(other.rect.x + other.rect.w <= segment.rect.x + segment.rect.w * 0.5 && other.rect.x < segment.rect.x){
            limits.left = limits.left === undefined ? other.rect.x + other.rect.w : Math.max(limits.left, other.rect.x + other.rect.w)
        }
    })
    return limits
}

/**
 * How many lines the original text takes. The height of the box divided by the height of a line says it, but a single line of letters with tall strokes comes out as
 * 1.7 or 2.1: when it says two, the text itself is measured (does it fit into the width of the box as one line?).
 */
export function linesOf(segment: TranslatedSegment, viewport: { width: number; height: number }): number {
    const lines = Math.max(1, Math.round(segment.rect.h / Math.max(0.001, segment.lineHeight)))
    if(lines !== 2){
        return lines
    }
    const size = Math.max(9, segment.lineHeight * viewport.height * 1.0)
    return textWidth(segment.original, size) < segment.rect.w * viewport.width * 1.3 ? 1 : 2
}

export function segmentStyle(segment: TranslatedSegment, viewport: { width: number; height: number }, autoFont: boolean, fixedSize: number, opacity: number, below?: number, sides?: { left?: number; right?: number }, bounds?: Region, sizeCap?: number, above?: number): CSSProperties {
    const originalWidth = segment.rect.w * viewport.width
    const left = segment.rect.x * viewport.width
    const centerX = left + originalWidth / 2

    // One line of the original stays one line: the translation may grow sideways (as far as the picture goes),
    // so it does not wrap onto the line below, which is another piece of text
    const lines = linesOf(segment, viewport)
    let room = segment.centered
        ? 2 * Math.min(centerX, viewport.width - centerX) - 16
        : viewport.width - left - 8
    // ... and not over the piece of text next to it on the same row
    if(sides !== undefined){
        const leftEdge = sides.left === undefined ? 0 : sides.left * viewport.width + 4
        const rightEdge = sides.right === undefined ? viewport.width : sides.right * viewport.width - 4
        room = segment.centered
            ? Math.min(room, 2 * Math.min(centerX - leftEdge, rightEdge - centerX))
            : Math.min(room, rightEdge - left)
    }
    // A text in a panel of the interface may use the whole panel (the width to its right edge, the height to its bottom)
    const panelWidth = bounds === undefined ? 0 : (bounds.x + bounds.w) * viewport.width - left - 10
    const panelHeight = bounds === undefined ? 0 : (bounds.y + bounds.h) * viewport.height - segment.rect.y * viewport.height - 6
    if(bounds !== undefined && !segment.centered){
        room = Math.min(room, Math.max(originalWidth, panelWidth))
    }

    // A paragraph keeps the width of the original (the translation is made to fit into it); one line may grow sideways
    const wide = Math.max(originalWidth * (lines === 1 ? 3.2 : 1.1), lines > 1 ? panelWidth : 0)
    const maxWidth = Math.max(Math.min(140, Math.max(60, room)), Math.min(room, wide))
    // The plate reaches a little over the original on every side, but not into the text next to it: where two lines are close, the margin between them is shared
    const marginTop = above === undefined ? 4 : Math.max(0, Math.min(4, (segment.rect.y - above) * viewport.height / 2))
    const marginBottom = below === undefined ? 4 : Math.max(0, Math.min(4, (below - segment.rect.y - segment.rect.h) * viewport.height / 2))
    const originalHeight = segment.rect.h * viewport.height + marginTop + marginBottom
    // How tall the box may get: a paragraph stays inside the box of the original, a single line may take one more row
    const roomHeight = lines === 1 ? originalHeight * 2 : originalHeight * 1.3
    let allowed = Math.max(originalHeight, below === undefined ? roomHeight : Math.min(roomHeight * 1.5, (below - segment.rect.y) * viewport.height - 6))
    // ... in a panel a paragraph may go down to the bottom of the panel (but not over the text under it)
    if(bounds !== undefined && lines > 1){
        allowed = Math.max(allowed, below === undefined ? panelHeight : Math.min(panelHeight, (below - segment.rect.y) * viewport.height - 6))
    }

    // The size of the original text; shrunk when the translation is longer than the original and would not fit
    let size = autoFont ? Math.min(56, Math.max(12, segment.lineHeight * viewport.height * 1.02)) : fixedSize
    // Text of the same kind (the same height of the original) is set in the same size: the translations are of different lengths, but the lines must not float
    if(sizeCap !== undefined){
        size = Math.min(size, sizeCap)
    }
    let singleLine = false
    if(autoFont){
        const base = size
        if(lines === 1){
            const wanted = textWidth(segment.translated, size)
            if(wanted > maxWidth){
                size = Math.max(size * 0.62, size * maxWidth / wanted)
            }
            singleLine = textWidth(segment.translated, size) <= maxWidth - 16
        }

        // The biggest size at which the translation fits into the box of the original
        if(!singleLine){
            const floor = Math.max(9.5, base * 0.5)
            while(size > floor && wrapRows(segment.translated, size, maxWidth - 20) * size * 1.22 + 12 > allowed){
                size = Math.max(floor, size * 0.94)
            }
        }
    }

    const [r, g, b] = segment.background
    // The box covers the original text completely (with a small margin around it)
    const style: CSSProperties = {
        top: 'calc(' + (segment.rect.y * 100) + '% - ' + marginTop + 'px)',
        whiteSpace: singleLine ? 'nowrap' : 'normal',
        maxWidth: maxWidth + 'px',
        minWidth: (Math.min(originalWidth, maxWidth) + 16) + 'px',
        minHeight: originalHeight + 'px',
        maxHeight: autoFont ? allowed + 'px' : undefined,
        overflow: 'hidden',
        fontSize: size + 'px',
        color: segment.foreground,
        background: 'rgba(' + r + ', ' + g + ', ' + b + ', ' + opacity + ')',
    }

    if(segment.centered){
        style.left = ((segment.rect.x + segment.rect.w / 2) * 100) + '%'
        style.transform = 'translateX(-50%)'
        style.textAlign = 'center'
        style.justifyContent = 'center'
    } else {
        style.left = 'calc(' + (segment.rect.x * 100) + '% - 8px)'
        style.textAlign = 'left'
        style.justifyContent = 'flex-start'
    }

    return style
}

/**
 * The font size every plate gets from the plates of its kind: plates whose originals are of the same height (within 10 %) are set in one size, the smallest one
 * that the longest of them needs (but a plate that needs much less than the others, a very long translation, keeps its own size and does not pull the rest down).
 * `finals` are the sizes the plates got on their own.
 */
export function sizeCaps(heights: number[], finals: number[]): Array<number | undefined> {
  const order = heights.map((h, i) => ({ h, i })).sort((a, b) => a.h - b.h);
  const caps: Array<number | undefined> = heights.map(() => undefined);
  let group: number[] = [];
  const close = () => {
    if (group.length >= 2) {
      const sizes = group.map((i) => finals[i]).sort((a, b) => a - b);
      const median = sizes[Math.floor((sizes.length - 1) / 2)];
      const cap = Math.max(sizes[0], median * 0.8);
      group.forEach((i) => { caps[i] = cap; });
    }
    group = [];
  };
  for (const item of order) {
    if (group.length > 0 && item.h > heights[group[0]] * 1.1) close();
    group.push(item.i);
  }
  close();
  return caps;
}
