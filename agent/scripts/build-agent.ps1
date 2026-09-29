[CmdletBinding()]
param(
    [switch]$Clean,
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$agentRoot = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $agentRoot 'release'
$work = Join-Path $agentRoot 'build-release'
$pyiDist = Join-Path $agentRoot 'dist-release'

if ($Clean) {
    Remove-Item -LiteralPath $dist -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pyiDist -Recurse -Force -ErrorAction SilentlyContinue
}
& $Python '-m' 'pip' 'install' '-r' (Join-Path $agentRoot 'requirements-build.lock')
if ($LASTEXITCODE -ne 0) { throw 'Could not install PyInstaller build dependency.' }
Push-Location $agentRoot
try {
    & $Python '-m' 'PyInstaller' '--clean' '--noconfirm' '--workpath' $work '--distpath' $pyiDist 'hybrid-agent.spec'
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed.' }
} finally { Pop-Location }

New-Item -ItemType Directory -Force -Path $dist | Out-Null
$exe = Join-Path $pyiDist 'HybridHostAgent.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "PyInstaller did not produce $exe" }
Copy-Item -LiteralPath $exe -Destination (Join-Path $dist 'HybridHostAgent.exe') -Force
Copy-Item -LiteralPath (Join-Path $agentRoot 'README.md') -Destination (Join-Path $dist 'README.md') -Force
Copy-Item -LiteralPath (Join-Path $agentRoot 'config.example.json') -Destination (Join-Path $dist 'config.example.json') -Force
Copy-Item -LiteralPath (Join-Path $agentRoot '..\LICENSE') -Destination (Join-Path $dist 'LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $agentRoot 'requirements.lock') -Destination (Join-Path $dist 'requirements.lock') -Force
Copy-Item -LiteralPath (Join-Path $agentRoot 'THIRD_PARTY_LICENSES.md') -Destination (Join-Path $dist 'THIRD_PARTY_LICENSES.md') -Force
Copy-Item -LiteralPath (Join-Path $agentRoot 'launch-agent.ps1') -Destination (Join-Path $dist 'Start-HybridHostAgent.ps1') -Force

$hash = (Get-FileHash -Algorithm SHA256 (Join-Path $dist 'HybridHostAgent.exe')).Hash.ToLowerInvariant()
"$hash  HybridHostAgent.exe" | Set-Content -LiteralPath (Join-Path $dist 'SHA256SUMS.txt') -Encoding ascii
$archive = Join-Path $agentRoot 'HybridHostAgent-windows-x64.zip'
Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $dist '*') -DestinationPath $archive -Force
$archiveHash = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
"$archiveHash  HybridHostAgent-windows-x64.zip" | Set-Content -LiteralPath (Join-Path $agentRoot 'HybridHostAgent-windows-x64-SHA256SUMS.txt') -Encoding ascii
Write-Host "Built $dist\HybridHostAgent.exe"
Write-Host "Packaged $archive"
Write-Host "SHA256 $hash"
