const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { spawn } = require('child_process')
const executable = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked', 'OfficeFlow.exe'))
const report = path.resolve(process.argv[3] || path.join(__dirname, '..', 'dist', 'release-smoke', 'verification.json'))
fs.mkdirSync(path.dirname(report), { recursive: true })
if (fs.existsSync(report)) fs.unlinkSync(report)
const child = spawn(executable, ['--release-smoke=' + report], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
child.stdout.on('data', value => { logs += value })
child.stderr.on('data', value => { logs += value })
const timer = setTimeout(() => child.kill(), 120000)
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
child.on('close', code => {
  clearTimeout(timer)
  try {
    assert(fs.existsSync(report), 'No release verification report; exit=' + code + '\n' + logs)
    const data = JSON.parse(fs.readFileSync(report, 'utf8'))
    assert(data.ok, JSON.stringify(data))
    assert.strictEqual(code, 0, logs)
    console.log(JSON.stringify(data, null, 2))
  } catch (error) { console.error(error); process.exitCode = 1 }
})
