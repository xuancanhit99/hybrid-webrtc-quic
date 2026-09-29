[CmdletBinding()]
param([switch]$Runtime)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Node/browser tests failed.' }

    Push-Location agent
    try {
        python -m unittest discover -s tests -v
        if ($LASTEXITCODE -ne 0) { throw 'Native agent tests failed.' }
        python -m hybrid_agent.agent --self-test-dependencies
        if ($LASTEXITCODE -ne 0) { throw 'Native agent dependency self-test failed.' }
    }
    finally { Pop-Location }

    if ($Runtime) {
        & (Join-Path $PSScriptRoot 'runtime-smoke.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'Docker runtime smoke failed.' }
    }
}
finally {
    Pop-Location
}
