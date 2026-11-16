# scripts/dev.ps1
# Local development launcher - one window per process, env inherited from .env.
#
#   .\scripts\dev.ps1                      # backend + agent + worker + portal + admin
#   .\scripts\dev.ps1 -Only backend
#   .\scripts\dev.ps1 -Only agent          # rag engine + index worker
#   .\scripts\dev.ps1 -Only web
#   .\scripts\dev.ps1 -Only infra          # delegates to start-infra.ps1
#   .\scripts\dev.ps1 -DryRun              # print the commands, start nothing
#
# Ports (docs/12 §1): backend 8088, engine 8100, portal 3100, admin 3101.

[CmdletBinding()]
param(
    [ValidateSet('all', 'backend', 'agent', 'web', 'infra')]
    [string]$Only = 'all',
    [switch]$WithInfra,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -Quiet

if ($Only -eq 'infra') {
    & (Join-Path $PSScriptRoot 'start-infra.ps1')
    exit $LASTEXITCODE
}

if ($WithInfra) {
    & (Join-Path $PSScriptRoot 'start-infra.ps1')
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[warn] infrastructure did not fully start; continuing with app processes.' -ForegroundColor Yellow
    }
}

function Start-DevWindow {
    param([string]$Title, [string]$WorkDir, [string]$DevCommand)
    $line = '[dev] ' + $Title + ' -> ' + $WorkDir + ' :: ' + $DevCommand
    Write-Host $line
    if ($DryRun) { return }
    if (-not (Test-Path -LiteralPath $WorkDir)) {
        Write-Host ('       skipped: directory not found (' + $WorkDir + ')') -ForegroundColor Yellow
        return
    }
    $exe = (Get-Command powershell -ErrorAction SilentlyContinue)
    $exePath = 'powershell.exe'
    if ($null -ne $exe) { $exePath = $exe.Source }
    $inner = '$Host.UI.RawUI.WindowTitle = ' + "'" + $Title + "'" + '; Set-Location -LiteralPath ' + "'" + $WorkDir + "'" + '; ' + $DevCommand
    Start-Process -FilePath $exePath -ArgumentList @('-NoExit', '-NoProfile', '-Command', $inner) -WorkingDirectory $WorkDir | Out-Null
}

$root = $env:KH_ROOT
$startBackend = ($Only -eq 'all' -or $Only -eq 'backend')
$startAgent = ($Only -eq 'all' -or $Only -eq 'agent')
$startWeb = ($Only -eq 'all' -or $Only -eq 'web')

Write-Host '=== knowledge-hub dev ===' -ForegroundColor Cyan
Write-Host ('root : ' + $root)
Write-Host ''

if ($startBackend) {
    Start-DevWindow -Title 'kh-backend:8088' -WorkDir (Join-Path $root 'backend') `
        -DevCommand 'mvn -pl platform-boot spring-boot:run'
}

if ($startAgent) {
    $agentDir = Join-Path $root 'agent'
    Start-DevWindow -Title 'kh-engine:8100' -WorkDir $agentDir `
        -DevCommand 'uv run uvicorn knowledge_hub.api.main:app --reload --host 127.0.0.1 --port 8100'
    Start-DevWindow -Title 'kh-worker' -WorkDir $agentDir `
        -DevCommand 'uv run kh-worker'
}

if ($startWeb) {
    $webDir = Join-Path $root 'web'
    # apps/portal and apps/admin already hardcode -p 3100 / -p 3101 in their dev scripts.
    Start-DevWindow -Title 'kh-portal:3100' -WorkDir $webDir `
        -DevCommand 'pnpm --filter ./apps/portal dev'
    Start-DevWindow -Title 'kh-admin:3101' -WorkDir $webDir `
        -DevCommand 'pnpm --filter ./apps/admin dev'
}

Write-Host ''
Write-Host '--- URLs ---' -ForegroundColor Cyan
if ($startBackend) {
    Write-Host ('backend      : ' + $env:BACKEND_BASE_URL)
    Write-Host ('  health     : ' + $env:BACKEND_BASE_URL + '/actuator/health')
    Write-Host ('  swagger    : ' + $env:BACKEND_BASE_URL + '/swagger-ui.html')
    Write-Host '  login      : admin / Admin@12345'
}
if ($startAgent) {
    Write-Host ('rag engine   : ' + $env:RAG_ENGINE_BASE_URL)
    Write-Host ('  health     : ' + $env:RAG_ENGINE_BASE_URL + '/health')
    Write-Host ('  openapi    : ' + $env:RAG_ENGINE_BASE_URL + '/docs')
    Write-Host 'index worker : (no port - consumes kh:stream:* from Redis)'
}
if ($startWeb) {
    Write-Host ('portal       : http://127.0.0.1:' + $env:PORTAL_PORT)
    Write-Host ('admin        : http://127.0.0.1:' + $env:ADMIN_PORT)
}
Write-Host ('middleware   : nacos console http://127.0.0.1:8080 | litellm http://127.0.0.1:4000 | langfuse http://127.0.0.1:3000 | minio http://127.0.0.1:9003')

if ($DryRun) {
    Write-Host ''
    Write-Host '[dry-run] nothing was started.' -ForegroundColor Yellow
}
exit 0
