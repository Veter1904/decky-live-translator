// A canvas and a video with real pixels (RGBA), for replaying frames that were recorded on the Deck
export class FakeCanvas {
    _w = 0
    _h = 0
    data: Uint8ClampedArray = new Uint8ClampedArray(0)
    fill = '#000000'
    _ctx: any
    get width() { return this._w }
    set width(v: number) { this._w = Math.max(0, Math.round(v)); this._alloc() }
    get height() { return this._h }
    set height(v: number) { this._h = Math.max(0, Math.round(v)); this._alloc() }
    _alloc() { this.data = new Uint8ClampedArray(this._w * this._h * 4) }
    getContext() {
        if(this._ctx) { return this._ctx }
        const canvas = this
        this._ctx = {
            drawImage(src: any, ...a: number[]) {
                let sx = 0, sy = 0, sw = 0, sh = 0, dx = 0, dy = 0, dw = 0, dh = 0
                const srcW = src.videoWidth ?? src.width, srcH = src.videoHeight ?? src.height
                if(a.length === 2) { sw = srcW; sh = srcH; dx = a[0]; dy = a[1]; dw = srcW; dh = srcH }
                else if(a.length === 4) { sw = srcW; sh = srcH; [dx, dy, dw, dh] = a }
                else { [sx, sy, sw, sh, dx, dy, dw, dh] = a }
                const sdata: Uint8ClampedArray = src.data
                for(let y = 0; y < dh; y++){
                    const ty = Math.round(dy) + y
                    if(ty < 0 || ty >= canvas._h) { continue }
                    const fy = sy + (y + 0.5) * sh / dh - 0.5
                    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(fy))), y1 = Math.min(srcH - 1, y0 + 1), wy = Math.max(0, Math.min(1, fy - y0))
                    for(let x = 0; x < dw; x++){
                        const tx = Math.round(dx) + x
                        if(tx < 0 || tx >= canvas._w) { continue }
                        const fx = sx + (x + 0.5) * sw / dw - 0.5
                        const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(fx))), x1 = Math.min(srcW - 1, x0 + 1), wx = Math.max(0, Math.min(1, fx - x0))
                        const o = (ty * canvas._w + tx) * 4
                        for(let c = 0; c < 3; c++){
                            const p00 = sdata[(y0 * srcW + x0) * 4 + c], p10 = sdata[(y0 * srcW + x1) * 4 + c], p01 = sdata[(y1 * srcW + x0) * 4 + c], p11 = sdata[(y1 * srcW + x1) * 4 + c]
                            canvas.data[o + c] = (p00 * (1 - wx) + p10 * wx) * (1 - wy) + (p01 * (1 - wx) + p11 * wx) * wy
                        }
                        canvas.data[o + 3] = 255
                    }
                }
            },
            getImageData(x: number, y: number, w: number, h: number) {
                const out = new Uint8ClampedArray(w * h * 4)
                for(let r = 0; r < h; r++){
                    const sy = y + r
                    if(sy < 0 || sy >= canvas._h) { continue }
                    out.set(canvas.data.subarray((sy * canvas._w + x) * 4, (sy * canvas._w + x + w) * 4), r * w * 4)
                }
                return { data: out, width: w, height: h }
            },
            putImageData(img: any, x: number, y: number) {
                for(let r = 0; r < img.height; r++){
                    const ty = y + r
                    if(ty < 0 || ty >= canvas._h) { continue }
                    canvas.data.set(img.data.subarray(r * img.width * 4, (r + 1) * img.width * 4), (ty * canvas._w + x) * 4)
                }
            },
            fillRect(x: number, y: number, w: number, h: number) {
                const v = parseInt(canvas.fill.replace('#', ''), 16)
                const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255
                for(let yy = Math.max(0, y); yy < Math.min(canvas._h, y + h); yy++){
                    for(let xx = Math.max(0, x); xx < Math.min(canvas._w, x + w); xx++){
                        const o = (yy * canvas._w + xx) * 4
                        canvas.data[o] = r; canvas.data[o + 1] = g; canvas.data[o + 2] = b; canvas.data[o + 3] = 255
                    }
                }
            },
            set fillStyle(v: string) { canvas.fill = v },
            get fillStyle() { return canvas.fill },
        }
        return this._ctx
    }
}

export const video: any = { videoWidth: 1920, videoHeight: 1080, readyState: 4, data: new Uint8ClampedArray(1920 * 1080 * 4) }

export function install() {
    ;(globalThis as any).document = { hidden: false, createElement: () => new FakeCanvas() }
    ;(globalThis as any).window = { location: { href: 'http://localhost/' } }
}
