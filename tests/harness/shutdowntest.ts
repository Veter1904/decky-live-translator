import { isReaderShutdownError } from 'E:/Greenlight/packages/desktop/renderer/lib/translator/readererrors'
const cases: Array<[any, boolean]> = [
    [new TypeError("Cannot read properties of null (reading 'postMessage')"), true],
    ["TypeError: Cannot read properties of null (reading 'postMessage')", true],
    [new TypeError("Cannot read properties of undefined (reading 'status')"), false],
    [new Error('network down'), false], [undefined, false], [null, false],
]
let bad = 0
for(const [reason, expected] of cases){ const got = isReaderShutdownError(reason); if(got !== expected) bad++; console.log(got === expected ? 'ok  ' : 'FAIL', String(reason).slice(0, 70), '->', got) }
process.exit(bad)
