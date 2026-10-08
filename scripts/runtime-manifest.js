const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const report = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'python', 'pip-install-report.json'), 'utf8'))
const packages = report.install.map(item => ({
  name: item.metadata.name, version: item.metadata.version,
  sha256: item.download_info.archive_info.hashes.sha256,
  url: item.download_info.url,
})).sort((a, b) => a.name.localeCompare(b.name))
const manifest = {
  python: {
    version: '3.14.8',
    sha256: 'a93abe456ab01bd96d7a085b3cdb6566b3063f4241360d114142fbdb07f0a310',
    url: 'https://www.python.org/ftp/python/3.14.8/python-3.14.8-embed-amd64.zip',
  },
  packages,
}
fs.writeFileSync(path.join(root, 'vendor', 'dependencies.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log('Bundled dependency manifest generated.')
