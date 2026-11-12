param([string]$ElectronZip)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ElectronZip) {
  $cacheRoot = Join-Path $env:LOCALAPPDATA 'electron\Cache'
  if (-not (Test-Path -LiteralPath $cacheRoot)) { $cacheRoot = Join-Path $env:USERPROFILE 'AppData\Local\electron\Cache' }
  $cached = Get-ChildItem -LiteralPath $cacheRoot -Recurse -File -Filter 'electron-v42.3.0-win32-x64.zip' | Select-Object -First 1
  if (-not $cached) { throw 'Electron 42.3.0 ZIP not found. Pass -ElectronZip or run npm install.' }
  $ElectronZip = $cached.FullName
}
$runtimePath = Join-Path $projectRoot '.runtime\electron'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
Expand-Archive -LiteralPath $ElectronZip -DestinationPath $runtimePath -Force
Write-Output "Electron runtime ready: $runtimePath"
