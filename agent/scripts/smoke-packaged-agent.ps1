[CmdletBinding()]
param([string]$Executable = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release\HybridHostAgent.exe'))

$ErrorActionPreference = 'Stop'
$agentRoot = Split-Path -Parent $PSScriptRoot
$productRoot = Split-Path -Parent $agentRoot
$listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$origin = "http://127.0.0.1:$port"
$control = $null
$agent = $null
$old = @{
    HOST = $env:HOST; PORT = $env:PORT; PUBLIC_ORIGIN = $env:PUBLIC_ORIGIN; SESSION_SECRET = $env:SESSION_SECRET
}

try {
    if (-not (Test-Path -LiteralPath $Executable)) { throw "Missing packaged agent: $Executable" }
    $env:HOST = '127.0.0.1'; $env:PORT = [string]$port; $env:PUBLIC_ORIGIN = $origin
    $env:SESSION_SECRET = [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
    $control = Start-Process -FilePath 'node' -ArgumentList 'src/server.mjs' -WorkingDirectory $productRoot -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        try { $health = Invoke-RestMethod "$origin/healthz" -TimeoutSec 2; if ($health.status -eq 'ok') { break } } catch {}
        Start-Sleep -Milliseconds 100
    }
    if ($health.status -ne 'ok') { throw 'Control plane did not become healthy.' }
    $identity = Invoke-RestMethod "$origin/api/v1/auth/enroll" -Method Post -ContentType 'application/json' -Body '{"email":"packaged-smoke@example.test","name":"Packaged smoke"}'
    $headers = @{ Authorization = "Bearer $($identity.token)" }
    $source = Invoke-RestMethod "$origin/api/v1/devices" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"name":"Controller","platform":"smoke"}'
    $target = Invoke-RestMethod "$origin/api/v1/devices" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"name":"Packaged Agent","platform":"windows-agent"}'
    $sessionBody = @{ sourceDeviceId = $source.device.id; targetDeviceId = $target.device.id } | ConvertTo-Json -Compress
    $remoteSession = Invoke-RestMethod "$origin/api/v1/sessions" -Method Post -Headers $headers -ContentType 'application/json' -Body $sessionBody
    $arguments = @('--control-url', $origin, '--token', $identity.token, '--device-id', $target.device.id, '--session-id', $remoteSession.session.id, '--insecure-http')
    $agent = Start-Process -FilePath $Executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 150; $attempt++) {
        $health = Invoke-RestMethod "$origin/healthz" -TimeoutSec 2
        if ($health.signalingConnections -eq 1) { break }
        if ($agent.HasExited) { throw "Packaged agent exited early with code $($agent.ExitCode)" }
        Start-Sleep -Milliseconds 100
    }
    if ($health.signalingConnections -ne 1) { throw 'Packaged agent did not establish signaling.' }
    Write-Host "Packaged agent smoke passed: signalingConnections=$($health.signalingConnections), pid=$($agent.Id)"
} finally {
    if ($control -and -not $control.HasExited) { Stop-Process -Id $control.Id -Force -ErrorAction SilentlyContinue }
    if ($agent -and -not $agent.HasExited) {
        try { Wait-Process -Id $agent.Id -Timeout 10 -ErrorAction Stop } catch { Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue }
    }
    $env:HOST = $old.HOST; $env:PORT = $old.PORT; $env:PUBLIC_ORIGIN = $old.PUBLIC_ORIGIN; $env:SESSION_SECRET = $old.SESSION_SECRET
}
