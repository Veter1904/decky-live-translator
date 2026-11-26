// Marks that stand next to a text on its row and are not part of it: the picture of a button of the pad ("(A) Select", "Drop left: [LB]"), an icon.
// A plate must not cover them, so the page gets the places where they begin, left and right of every one-line text.

export interface Stops { left?: number; right?: number }

/** A pixel belongs to a mark when its brightness differs this much from the colour behind the text */
const CONTRAST = 48
/** How far from the text a mark is looked for, in heights of a line */
const REACH = 2.2
/** A mark is at least this wide and this tall (in heights of a line): a thin frame, a divider or a speck is not one */
const MIN_WIDTH = 0.45
const MIN_HEIGHT = 0.55
/** ... and not wider than this: something that goes on and on is the picture behind the text */
const MAX_WIDTH = 2.0

/**
 * Looks at the strips left and right of a one-line text (all values in pixels of the picture; `rect` is the box of the text) and returns where the
 * nearest mark on each side ends (left) or begins (right), in pixels.
 */
export function findStops(rgba: Uint8ClampedArray, width: number, height: number, rect: { x: number; y: number; w: number; h: number }, lineHeight: number, background: [number, number, number]): Stops {
    // two lines or more: a paragraph, it keeps the width of the original anyway
    if (rect.h > Math.max(8, lineHeight) * 1.9) return {}
    const line = Math.max(8, Math.min(96, Math.max(lineHeight, rect.h * 0.8)))
    const y0 = Math.max(0, Math.floor(rect.y - line * 0.15))
    const y1 = Math.min(height, Math.ceil(rect.y + rect.h + line * 0.15))
    if (y1 - y0 < 6) return {}
    const behind = (background[0] * 299 + background[1] * 587 + background[2] * 114) / 1000
    const lumaAt = (x: number, y: number) => { const o = (y * width + x) * 4; return (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000 }
    // The picture behind a text of the game is not one colour (a scene): a pixel of a mark differs from the colour behind the text AND from what is just above
    // and below the strip in the same column (a dark vine behind a button is dark there too)
    const aroundAt = (x: number): number => {
        const values: number[] = []
        const far = Math.ceil(line * 0.35)
        for (let y = Math.max(0, y0 - far); y < y0; y++) values.push(lumaAt(x, y))
        for (let y = y1; y < Math.min(height, y1 + far); y++) values.push(lumaAt(x, y))
        if (values.length === 0) return behind
        values.sort((a, b) => a - b)
        return values[Math.floor(values.length / 2)]
    }

    const side = (from: number, step: 1 | -1): number | undefined => {
        let start = -1
        let top = y1
        let bottom = y0
        let last = -1
        const reach = Math.ceil(line * REACH)
        for (let offset = 0; offset <= reach; offset++) {
            const x = from + step * offset
            let count = 0
            let first = -1
            let end = -1
            if (x >= 0 && x < width) {
                const around = aroundAt(x)
                for (let y = y0; y < y1; y++) {
                    const luma = lumaAt(x, y)
                    if (Math.abs(luma - behind) > CONTRAST && Math.abs(luma - around) > CONTRAST) {
                        count++
                        if (first < 0) first = y
                        end = y
                    }
                }
            }
            if (count >= 2) {
                if (start < 0) { start = offset; top = y1; bottom = y0 }
                top = Math.min(top, first)
                bottom = Math.max(bottom, end)
                last = offset
            } else if (start >= 0 && offset - last > 1) {
                // a run ended: is it a mark? A run that begins at the edge of the text is the end of a letter that the box cut
                const wide = last - start + 1
                if (start >= 2 && wide >= line * MIN_WIDTH && wide <= line * MAX_WIDTH && bottom - top + 1 >= line * MIN_HEIGHT) return from + step * start
                start = -1
            }
        }
        // a run that goes on to the end of the strip
        if (start >= 2 && last - start + 1 >= line * MIN_WIDTH && last - start + 1 <= line * MAX_WIDTH && bottom - top + 1 >= line * MIN_HEIGHT) return from + step * start
        return undefined
    }

    const stops: Stops = {}
    const right = side(Math.floor(rect.x + rect.w), 1)
    const left = side(Math.ceil(rect.x) - 1, -1)
    if (right !== undefined) stops.right = right
    if (left !== undefined) stops.left = left + 1
    return stops
}
