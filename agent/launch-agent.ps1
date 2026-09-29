[CmdletBinding()]
param(
    [string]$Config = (Join-Path $PSScriptRoot 'config.json'),
    [switch]$BuildIfMissing,
    [switch]$ShareScreen,
    [switch]$AllowInput,
    [switch]$Unattended,
    [string]$ConsentFile,
    [string]$DownloadDir,
    [string]$SessionId,
    [string]$DeviceId,
    [string]$Token
)

$ErrorActionPreference = 'Stop'
$agentRoot = $PSScriptRoot
$exe = Join-Path $agentRoot 'HybridHostAgent.exe'
if (-not (Test-Path -LiteralPath $exe)) { $exe = Join-Path $agentRoot 'release\HybridHostAgent.exe' }
$python = Join-Path $agentRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $Config)) {
    $example = Join-Path $agentRoot 'config.example.json'
    if (-not (Test-Path -LiteralPath $example)) { throw "Missing config example: $example" }
    Copy-Item -LiteralPath $example -Destination $Config
    Write-Host "Created $Config. Edit session_id/email/device values, then run this launcher again."
    exit 0
}

$configObject = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if ($AllowInput -or $Unattended) {
    if (-not $ConsentFile) { $ConsentFile = [string]$configObject.consent_file }
    if (-not $ConsentFile -or -not (Test-Path -LiteralPath $ConsentFile)) { throw '--allow-input/--unattended requires an existing -ConsentFile' }
    if ((Get-Content -LiteralPath $ConsentFile -Raw).Trim() -ne 'I_UNDERSTAND_REMOTE_INPUT') { throw 'Consent file has the wrong phrase' }
}
if ($Unattended -and -not $AllowInput) { throw '-Unattended requires -AllowInput' }

$args = @('--config', $Config)
if ($ShareScreen) { $args += '--share-screen' }
if ($AllowInput) { $args += '--allow-input', '--consent-file', $ConsentFile }
if ($Unattended) { $args += '--unattended' }
if ($DownloadDir) { $args += '--download-dir', $DownloadDir }
if ($SessionId) { $args += '--session-id', $SessionId }
if ($DeviceId) { $args += '--device-id', $DeviceId }
if ($Token) { $args += '--token', $Token }

if (Test-Path -LiteralPath $exe) {
    & $exe @args
    exit $LASTEXITCODE
}
if ($BuildIfMissing) {
    $build = Join-Path $agentRoot 'scripts\build-agent.ps1'
    if (-not (Test-Path -LiteralPath $build)) { throw "Build script is unavailable: $build" }
    & $build
    if ($LASTEXITCODE -ne 0) { throw 'Agent build failed.' }
    $exe = Join-Path $agentRoot 'release\HybridHostAgent.exe'
    & $exe @args
    exit $LASTEXITCODE
}
if (Test-Path -LiteralPath $python) {
    Push-Location $agentRoot
    try { & $python '-m' 'hybrid_agent.agent' @args; exit $LASTEXITCODE } finally { Pop-Location }
}
throw "No packaged executable or Python venv found. Build with scripts/build-agent.ps1 or install agent requirements."
