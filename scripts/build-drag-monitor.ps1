$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$frameworks = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319')
)
$framework = $frameworks | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'csc.exe') } | Select-Object -First 1
if (-not $framework) { throw 'The .NET Framework C# compiler was not found.' }
$references = @(
  (Join-Path $framework 'Accessibility.dll'),
  (Join-Path $framework 'WPF\UIAutomationClient.dll'),
  (Join-Path $framework 'WPF\UIAutomationTypes.dll'),
  (Join-Path $framework 'WPF\WindowsBase.dll')
)
foreach ($reference in $references) {
  if (-not (Test-Path -LiteralPath $reference)) { throw "Missing framework reference: $reference" }
}
$source = Join-Path $root 'app-source\drag-monitor.cs'
$output = Join-Path $root 'app-source\drag-monitor.exe'
$arguments = @('/nologo', '/target:exe', '/optimize+', '/warn:4', '/warnaserror+', "/out:$output")
$arguments += $references | ForEach-Object { "/reference:$_" }
$arguments += $source
& (Join-Path $framework 'csc.exe') @arguments
if ($LASTEXITCODE -ne 0) { throw 'Drag monitor compilation failed.' }
Write-Output "Generated: $output"
