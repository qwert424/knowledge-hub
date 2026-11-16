# scripts/check-docker.ps1
# Pre-flight check: is the Docker daemon usable, and are the ports we publish free?
#
#   .\scripts\check-docker.ps1
#   .\scripts\check-docker.ps1 -Ports 8088,8100
#   .\scripts\check-docker.ps1 -SkipReused     # do not report on reused middleware ports
#
# Exit codes: 0 = ready, 1 = daemon down or one of our ports is taken.

[CmdletBinding()]
param(
    [int[]]$Ports = @(8088, 8100, 3100, 3101, 5433, 6380),
    [int[]]$ReusedPorts = @(19530, 8848, 8080, 4000, 9002, 9003, 3000, 7474, 7687),
    [switch]$SkipReused
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'env.ps1') -Quiet

$failures = 0

function Write-Ok { param([string]$Text) Write-Host ('[OK]   ' + $Text) -ForegroundColor Green }
function Write-Bad { param([string]$Text) Write-Host ('[FAIL] ' + $Text) -ForegroundColor Red; $script:failures = $script:failures + 1 }
function Write-Warn2 { param([string]$Text) Write-Host ('[WARN] ' + $Text) -ForegroundColor Yellow }
function Write-Info { param([string]$Text) Write-Host ('[info] ' + $Text) }

Write-Host '=== docker / port pre-flight ===' -ForegroundColor Cyan

# ------------------------------------------------------------------ docker cli
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if ($null -eq $dockerCmd) {
    Write-Bad 'docker CLI not found in PATH - install Docker Desktop'
} else {
    Write-Ok ('docker CLI: ' + $dockerCmd.Source)
    $clientVersion = (& docker version --format '{{.Client.Version}}' 2>$null)
    if ($LASTEXITCODE -eq 0) { Write-Ok ('docker client version: ' + $clientVersion) }

    $serverVersion = (& docker info --format '{{.ServerVersion}}' 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($serverVersion)) {
        Write-Bad 'Docker daemon is not reachable - start Docker Desktop and wait for "Engine running"'
        Write-Info 'If it is running, check: docker context ls  (expected: desktop-linux)'
    } else {
        Write-Ok ('docker engine version: ' + $serverVersion)
        $composeVersion = (& docker compose version --short 2>$null)
        if ($LASTEXITCODE -eq 0) {
            Write-Ok ('docker compose: ' + $composeVersion)
        } else {
            Write-Bad 'docker compose plugin missing'
        }
    }
}

# ------------------------------------------------------------- port utilities
function Get-PortOwner {
    param([int]$Port)
    $owner = $null
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($null -ne $conn) {
            $procName = 'unknown'
            try {
                $procName = (Get-Process -Id $conn.OwningProcess -ErrorAction Stop).ProcessName
            } catch { }
            $owner = [pscustomobject]@{ Port = $Port; Pid = $conn.OwningProcess; Process = $procName }
        }
    } catch {
        # Get-NetTCPConnection unavailable -> netstat fallback
        $pattern = ':' + $Port + '\s'
        $lines = (& netstat -ano -p TCP 2>$null) | Select-String -Pattern $pattern
        foreach ($l in $lines) {
            $parts = ($l.Line.Trim() -split '\s+')
            if ($parts.Length -ge 5 -and $parts[3] -eq 'LISTENING') {
                $procId = [int]$parts[4]
                $procName = 'unknown'
                try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
                $owner = [pscustomobject]@{ Port = $Port; Pid = $procId; Process = $procName }
                break
            }
        }
    }
    return $owner
}

Write-Host ''
Write-Host '--- ports we publish (must be FREE) ---' -ForegroundColor Cyan
foreach ($port in $Ports) {
    $owner = Get-PortOwner -Port $port
    if ($null -eq $owner) {
        Write-Ok ('port ' + $port + ' free')
    } else {
        Write-Bad ('port ' + $port + ' already in use by ' + $owner.Process + ' (pid ' + $owner.Pid + ')')
    }
}

if (-not $SkipReused) {
    Write-Host ''
    Write-Host '--- reused middleware ports (expected BUSY when the stack is up) ---' -ForegroundColor Cyan
    foreach ($port in $ReusedPorts) {
        $owner = Get-PortOwner -Port $port
        if ($null -eq $owner) {
            Write-Warn2 ('port ' + $port + ' free - that middleware is not running (see scripts/start-infra.ps1)')
        } else {
            Write-Info ('port ' + $port + ' in use by ' + $owner.Process + ' (pid ' + $owner.Pid + ')')
        }
    }
    Write-Host ''
    Write-Host 'Reminder: Nacos console owns 8080 and Langfuse owns 3000.' -ForegroundColor Yellow
    Write-Host '          Never publish our services on 8080/3000 (portal=3100, admin=3101, nginx=8081).'
}

Write-Host ''
if ($failures -gt 0) {
    Write-Host ('[FAIL] ' + $failures + ' blocking issue(s).') -ForegroundColor Red
    Write-Host 'Hints:'
    Write-Host '  netstat -ano | findstr :8088        # find the offender'
    Write-Host '  tasklist /FI "PID eq <pid>"         # identify it'
    Write-Host '  override ports in .env (SERVER_PORT, PORTAL_PORT, ADMIN_PORT, RAG_ENGINE_PORT, KH_PG_PORT, KH_REDIS_PORT)'
    exit 1
}

Write-Host '[OK] ready to run: docker compose up -d' -ForegroundColor Green
exit 0
