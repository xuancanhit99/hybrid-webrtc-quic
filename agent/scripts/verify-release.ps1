[CmdletBinding()]
param([string]$Release = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'))

$ErrorActionPreference = 'Stop'
$exe = Join-Path $Release 'HybridHostAgent.exe'
$sumFile = Join-Path $Release 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $sumFile)) { $sumFile = Join-Path $Release 'HybridHostAgent-SHA256SUMS.txt' }
if (-not (Test-Path -LiteralPath $exe)) { throw "Missing $exe" }
if (-not (Test-Path -LiteralPath $sumFile)) { throw "Missing $sumFile" }
$expected = ((Get-Content -LiteralPath $sumFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw "Checksum mismatch: expected $expected, got $actual" }
$help = & $exe '--help' 2>&1
if ($LASTEXITCODE -ne 0 -or (($help -join "`n") -notmatch 'Hybrid WebRTC Windows host agent')) { throw 'Packaged executable help check failed.' }
Write-Host "Release verification passed: $exe"
