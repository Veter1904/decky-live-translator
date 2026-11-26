// The few things the engine needs from its surroundings, so the same code runs in a worker (plugin) and in tests.
let base = ''
let scoutUrl = ''

export function initEnv(assetBase: string, scoutWorkerCode: string) {
    base = assetBase
    scoutUrl = URL.createObjectURL(new Blob([scoutWorkerCode], { type: 'application/javascript' }))
}

/** URL of a file the capture helper serves from the plugin's assets folder. */
export function assetUrl(path: string): string {
    return base + '/assets/' + path
}

export function makeCanvas(): any {
    return new OffscreenCanvas(1, 1)
}

export function makeScoutWorker(): Worker {
    return new Worker(scoutUrl)
}
