// Runs the engine on every recorded set (tests/sets/*) until it is quiet (IDLE mode: the same numbers every run) and prints a table.
// usage (from tests/harness after `ENTRY=evalset node build.js`):  node ../run-all.cjs
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path')
const sets = path.join(__dirname, 'sets')
let found = 0, total = 0, extra = 0
const rows = []
for (const name of fs.readdirSync(sets).sort()) {
    const dir = path.join(sets, name)
    const r = spawnSync('node', ['evalset.cjs', '12', dir, path.join(dir, 'truth.json')], { cwd: path.join(__dirname, 'harness'), env: { ...process.env, IDLE: '1' }, encoding: 'utf8', timeout: 900000 })
    const m = /TOTAL recall (\d+)\/(\d+) (\d+)%\s+extra readings (\d+)/.exec(r.stdout || '')
    if (!m) { rows.push(name.padEnd(6) + ' FAILED ' + (r.stderr || '').slice(0, 200)); continue }
    found += +m[1]; total += +m[2]; extra += +m[4]
    rows.push(name.padEnd(6) + (m[1] + '/' + m[2]).padStart(7) + (m[3] + ' %').padStart(7) + '  extra ' + m[4])
}
console.log(rows.join('\n'))
console.log('ALL    ' + (found + '/' + total).padStart(7) + (Math.round(100 * found / Math.max(1, total)) + ' %').padStart(7) + '  extra ' + extra)
