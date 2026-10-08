const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const assert = require('assert')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

const root = path.resolve(__dirname, '..')
const out = path.join(root, 'release-artifacts')
const pkg = require('../app-source/package.json')
const sources = [
  {
    name: 'pymupdf-1.28.2.tar.gz',
    url: 'https://files.pythonhosted.org/packages/a3/fb/b6761fa2d5266f2cdb24c3b91f4023070ab7848381417678e7a289a1d52a/pymupdf-1.28.2.tar.gz',
    sha256: '5e0be7908a715aa20333caddd73f1d6f01e4cd0c26e869fa2dd0b7f344da2249',
  },
  {
    name: 'mupdf-1.28.2-source.tar.gz',
    url: 'https://mupdf.com/downloads/archive/mupdf-1.28.2-source.tar.gz',
    sha256: '44075a84e329db55b9bef5f342a70fd26d69e48ad1d33cb89d9664581c641156',
  },
]

async function hash(file) {
  const sha = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) sha.update(chunk)
  return sha.digest('hex')
}

async function stageSource(source) {
  const file = path.join(out, source.name)
  if (!fs.existsSync(file)) {
    console.log('Downloading corresponding source: ' + source.name)
    const response = await fetch(source.url, { signal: AbortSignal.timeout(300000) })
    assert(response.ok, 'Source download failed: ' + response.status)
    const temporary = file + '.download'
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary))
    assert.strictEqual(await hash(temporary), source.sha256, 'Source checksum mismatch: ' + source.name)
    fs.renameSync(temporary, file)
  }
  assert.strictEqual(await hash(file), source.sha256, 'Source checksum mismatch: ' + source.name)
}

async function auditPython(inventory) {
  const packages = await Promise.all(inventory.packages.map(async p => {
    const url = 'https://pypi.org/pypi/' + encodeURIComponent(p.name) + '/' + encodeURIComponent(p.version) + '/json'
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    assert(response.ok, 'Dependency advisory lookup failed: ' + p.name)
    const info = await response.json()
    return { name: p.name, version: p.version, source: url, vulnerabilities: (info.vulnerabilities || []).map(v => ({ id: v.id, aliases: v.aliases, fixedIn: v.fixed_in, link: v.link })) }
  }))
  const report = { checkedAt: new Date().toISOString(), source: 'PyPI vulnerability metadata', packages, knownAdvisoryCount: packages.reduce((n, p) => n + p.vulnerabilities.length, 0) }
  fs.writeFileSync(path.join(out, 'python-dependency-audit.json'), JSON.stringify(report, null, 2) + '\n')
  assert.strictEqual(report.knownAdvisoryCount, 0, 'Bundled Python dependencies have published advisories; update and rebuild before releasing')
}

async function main() {
  fs.mkdirSync(out, { recursive: true })
  const report = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'release-smoke', 'verification.json'), 'utf8'))
  assert.strictEqual(report.ok, true, 'Release smoke verification failed')
  assert.strictEqual(report.version, pkg.version, 'Test report version mismatch')
  assert.strictEqual(report.electron, pkg.devDependencies.electron, 'Electron version mismatch')
  const packagedManifest = path.join(root, 'dist', 'win-unpacked', 'resources', 'dependencies.json')
  const inventory = JSON.parse(fs.readFileSync(packagedManifest, 'utf8'))
  assert(inventory.packages.some(p => p.name.toLowerCase() === 'pymupdf' && p.version === '1.28.2'), 'Corresponding source version mismatch')
  await auditPython(inventory)
  const files = [
    ['dist/OfficeFlow-' + pkg.version + '-Setup-x64.exe', 'OfficeFlow-' + pkg.version + '-Setup-x64.exe'],
    ['dist/OfficeFlow-' + pkg.version + '-Windows-x64.zip', 'OfficeFlow-' + pkg.version + '-Windows-x64.zip'],
    ['docs/RELEASE.md', 'README-Windows.md'],
    ['docs/THIRD_PARTY_SOURCES.md', 'THIRD_PARTY_SOURCES.md'],
    ['LICENSE', 'LICENSE.OfficeFlow.txt'],
    ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
    ['dist/win-unpacked/resources/dependencies.json', 'dependencies.json'],
  ]
  for (const [from, to] of files) fs.copyFileSync(path.join(root, from), path.join(out, to))
  // Publish only the documented boolean/number checks, never app data, logs or paths.
  const safeReport = {}
  for (const key of ['ok', 'version', 'electron', 'platform', 'arch', 'rendererIsolation', 'homeRendered', 'bundledPython', 'localTableRows', 'xlsxExport', 'overlayHiddenAtIdle', 'overlayBridgeReady', 'dragMonitorReady', 'closeKeepsBackground', 'aiTokensUsed']) {
    assert(Object.hasOwn(report, key), 'Missing verification field: ' + key)
    safeReport[key] = report[key]
  }
  fs.writeFileSync(path.join(out, 'release-verification.json'), JSON.stringify(safeReport, null, 2) + '\n')
  await Promise.all(sources.map(stageSource))
  const names = [...files.map(([, to]) => to), 'release-verification.json', 'python-dependency-audit.json', ...sources.map(s => s.name)].sort()
  const checksums = []
  for (const name of names) checksums.push(await hash(path.join(out, name)) + '  ' + name)
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), checksums.join('\n') + '\n')
  fs.writeFileSync(path.join(out, 'assets.json'), JSON.stringify([...names, 'SHA256SUMS.txt'], null, 2) + '\n')
  console.log('Prepared ' + (names.length + 1) + ' verified release assets in release-artifacts.')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
