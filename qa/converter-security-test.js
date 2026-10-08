const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { execFileSync } = require('child_process')

async function main() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app-source', 'electron.js'), 'utf8')
  const escapeStart = source.indexOf('function escapePS(')
  const escapeEnd = source.indexOf('function runPowerShell(', escapeStart)
  const convertersStart = source.indexOf('async function convertWordToPdf(')
  const convertersEnd = source.indexOf('async function convertPdfToImages(', convertersStart)
  assert(escapeStart >= 0 && escapeEnd > escapeStart && convertersEnd > convertersStart)
  const output = "C:\\Output\\it's `literal $(1+1).pdf"
  const input = "C:\\Input\\it's `literal $(1+1).docx"
  const scripts = []
  const context = {
    path,
    OUTPUT_DIR: path.dirname(output),
    send() {},
    outputFilePath() { return output },
    runPowerShell(script) { scripts.push(script); return { ok: true, path: output } },
  }
  vm.createContext(context)
  vm.runInContext(source.slice(escapeStart, escapeEnd) + source.slice(convertersStart, convertersEnd), context)
  const names = [
    'convertWordToPdf', 'convertWordToText', 'convertExcelToCsv',
    'convertExcelToPdf', 'convertPptToPdf', 'convertPdfToText',
  ]
  for (const name of names) {
    await context[name](input, 0, 1)
    const script = scripts[scripts.length - 1]
    assert(script.includes('.AutomationSecurity = 3'), name + ' must disable macros')
    const success = script.split('\n').find(line => line.trim().startsWith("Write-Output 'OK:"))
    assert(success, name + ' must use a literal output path')
    const command = script.includes('$x.Workbooks.Open') ? /\$x\.Workbooks\.Open\('((?:[^']|'')*)', 0, \$true\)/
      : script.includes('$p.Presentations.Open') ? /\$p\.Presentations\.Open\('((?:[^']|'')*)', -1, 0, 0\)/
      : /\$w\.Documents\.Open\('((?:[^']|'')*)', \$false, \$true, \$false\)/
    assert(command.test(script), name + ' must open read-only with correctly quoted input')
  }
  const outputs = scripts.map(script => script.split('\n').find(line => line.trim().startsWith("Write-Output 'OK:"))).join('\n')
  const encoded = Buffer.from("$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" + outputs, 'utf16le').toString('base64')
  const result = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim().split(/\r?\n/)
  assert.deepStrictEqual(result, names.map(() => 'OK:' + output))
  await context.convertPptToImages(input, 0, 1)
  assert(scripts[scripts.length - 1].includes("Write-Output ('OK:' + ($results -join '|'))"))
  console.log('Converter path/security tests: OK')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
