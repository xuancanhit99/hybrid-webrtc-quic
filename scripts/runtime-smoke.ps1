$ErrorActionPreference = 'Stop'
$composeProject = "hybrid-smoke-$PID"
$sessionSecret = [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
$enrollmentToken = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
$turnSecret = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
$env:SESSION_SECRET = $sessionSecret
$env:ENROLLMENT_TOKEN = $enrollmentToken
$env:TURN_SECRET = $turnSecret
$env:TURN_BIND = '127.0.0.1'
$compose = @('-f', 'docker-compose.yml', '-f', 'docker-compose.smoke.yml', '-p', $composeProject)

try {
  & docker compose @compose up --build --wait control coturn
  if ($LASTEXITCODE -ne 0) { throw "docker compose up failed with exit code $LASTEXITCODE" }
  $healthJson = & docker compose @compose exec -T control node -e "fetch('http://127.0.0.1:8787/healthz').then(async r=>{process.stdout.write(await r.text());if(!r.ok)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})"
  if ($LASTEXITCODE -ne 0) { throw "control health probe failed with exit code $LASTEXITCODE" }
  $health = $healthJson | ConvertFrom-Json
  if ($health.status -ne 'ok') { throw "Unexpected health status: $($health.status)" }
  $containers = & docker compose @compose ps --format json | ConvertFrom-Json
  if (@($containers).Count -lt 2) { throw 'Expected control and coturn containers' }
  foreach ($container in @($containers)) {
    if ($container.State -ne 'running' -or $container.Health -ne 'healthy') { throw "Container $($container.Name) is not healthy" }
    if (@($container.Publishers | Where-Object { $_.PublishedPort -gt 0 }).Count -ne 0) { throw "Smoke override unexpectedly published a host port for $($container.Name)" }
  }
  Write-Host "Hybrid runtime smoke passed: $($health.status), containers=$(@($containers).Count)"
} finally {
  & docker compose @compose down --remove-orphans --volumes 2>$null
  Remove-Item Env:SESSION_SECRET,Env:ENROLLMENT_TOKEN,Env:TURN_SECRET,Env:TURN_BIND -ErrorAction SilentlyContinue
}
