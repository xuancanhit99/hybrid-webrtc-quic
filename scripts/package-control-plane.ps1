[CmdletBinding()]
param([string]$Output = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'))

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $Output 'control-plane'
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'src'),(Join-Path $stage 'public'),(Join-Path $stage 'coturn') | Out-Null
foreach ($file in @('Dockerfile','docker-compose.yml','package.json','package-lock.json','.env.example','LICENSE','README.md')) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage -Force }
Copy-Item -Path (Join-Path $root 'src\*') -Destination (Join-Path $stage 'src') -Recurse -Force
Copy-Item -Path (Join-Path $root 'public\*') -Destination (Join-Path $stage 'public') -Recurse -Force
Copy-Item -Path (Join-Path $root 'coturn\*') -Destination (Join-Path $stage 'coturn') -Recurse -Force
$archive = Join-Path $Output 'HybridControlPlane-docker.zip'
Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
$hash = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
"$hash  HybridControlPlane-docker.zip" | Set-Content -LiteralPath (Join-Path $Output 'SHA256SUMS.txt') -Encoding ascii
Write-Host "Packaged $archive"
