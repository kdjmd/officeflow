param([string]$PythonCommand = 'python')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vendor = [System.IO.Path]::GetFullPath((Join-Path $root 'vendor'))
$target = [System.IO.Path]::GetFullPath((Join-Path $vendor 'python'))
if (-not $target.StartsWith($vendor + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe runtime directory' }
New-Item -ItemType Directory -Path $vendor -Force | Out-Null
$archive = Join-Path $vendor 'python-3.14.8-embed-amd64.zip'
$expectedHash = 'a93abe456ab01bd96d7a085b3cdb6566b3063f4241360d114142fbdb07f0a310'
if (-not (Test-Path -LiteralPath $archive)) {
  Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.14.8/python-3.14.8-embed-amd64.zip' -OutFile $archive
}
$stream = [System.IO.File]::OpenRead($archive)
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $actualHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $sha.Dispose() }
if ($actualHash -ne $expectedHash) { throw 'Python runtime SHA256 mismatch' }
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $target)
$sitePackages = Join-Path $target 'Lib\site-packages'
New-Item -ItemType Directory -Path $sitePackages -Force | Out-Null
$lock = Join-Path $root 'app-source\requirements-release.txt'
if (-not (Test-Path -LiteralPath $lock)) { $lock = Join-Path $root 'app-source\requirements.txt' }
& $PythonCommand -m pip install --disable-pip-version-check --no-compile --only-binary=:all: --platform win_amd64 --python-version 3.14 --implementation cp --abi cp314 --target $sitePackages -r $lock --report (Join-Path $target 'pip-install-report.json')
if ($LASTEXITCODE -ne 0) { throw 'Python dependency staging failed' }
Set-Content -LiteralPath (Join-Path $target 'python314._pth') -Encoding ASCII -Value @('python314.zip', '.', 'Lib\site-packages', 'import site')
& (Join-Path $target 'python.exe') -c 'import pypdf,reportlab,PIL,fitz,openpyxl,pdfplumber; print(1)'
if ($LASTEXITCODE -ne 0) { throw 'Bundled Python dependency verification failed' }
& node (Join-Path $root 'scripts\runtime-manifest.js')
if ($LASTEXITCODE -ne 0) { throw 'Runtime manifest generation failed' }
Write-Output "Prepared: $target"
