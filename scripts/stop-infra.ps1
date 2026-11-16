# scripts/stop-infra.ps1
# The middleware we use is owned by the OTHER compose project (`deal-pilot-rag`)
# and may serve other work, so stopping it requires -Force.
#
#   .\scripts\stop-infra.ps1                 # explain who owns what, change nothing
#   .\scripts\stop-infra.ps1 -App            # stop only knowledge-hub's own containers
#   .\scripts\stop-infra.ps1 -Force          # docker compose stop on the reused middleware
#   .\scripts\stop-infra.ps1 -App -Force     # both
#   .\scripts\stop-infra.ps1 -StatusOnly     # just show what is running
#
# `down` is never used and volumes are never removed: data stays intact.

[CmdletBinding()]
param(
    [string]$RefCompose = '',
    [switch]$Force,
    [switch]$App,
    [switch]$StatusOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -Quiet

if ([string]::IsNullOrWhiteSpace($RefCompose)) { $RefCompose = $env:KH_REF_COMPOSE }

$coreServices = @('litellm', 'nacos', 'shared-minio', 'milvus', 'milvus-minio', 'milvus-etcd', 'neo4j')

function Invoke-NativeCapture {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @()
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & $FilePath @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    $lines = @($raw | ForEach-Object { [string]$_ })
    return [pscustomobject]@{ Output = ($lines -join ' '); Lines = $lines; ExitCode = $code }
}

function Test-DockerDaemon {
    $probe = Invoke-NativeCapture -FilePath 'docker' -Arguments @('info', '--format', '{{.ServerVersion}}')
    return ($probe.ExitCode -eq 0)
}

Write-Host '=== knowledge-hub stop ===' -ForegroundColor Cyan

if (-not (Test-DockerDaemon)) {
    Write-Host '[FAIL] Docker daemon is not reachable. Nothing to stop.' -ForegroundColor Red
    exit 2
}

$envFile = Join-Path $env:KH_ROOT '.env'

# ------------------------------------------------------------------ own stack
if ($App -or $StatusOnly) {
    Write-Host ''
    Write-Host '[app] knowledge-hub containers: kh-postgres, kh-redis, kh-backend, kh-agent, kh-worker, kh-portal, kh-admin'
    if ($StatusOnly) {
        $ps = Invoke-NativeCapture -FilePath 'docker' -Arguments @('compose', '--env-file', $envFile, '-f', $env:KH_COMPOSE_APP, 'ps')
        foreach ($line in $ps.Lines) { Write-Host $line }
    } elseif (-not $App) {
        Write-Host '      (pass -App to stop them)'
    } else {
        $stopApp = Invoke-NativeCapture -FilePath 'docker' -Arguments @('compose', '--env-file', $envFile, '-f', $env:KH_COMPOSE_APP, 'stop')
        foreach ($line in $stopApp.Lines) { Write-Host $line }
        Write-Host ('[app] stop exit code: ' + $stopApp.ExitCode)
    }
}

# ----------------------------------------------------------- reused middleware
Write-Host ''
Write-Host '[infra] owned by the REUSED RAG stack - not by this project:'
Write-Host ('        compose file : ' + $RefCompose)
Write-Host '        project name : deal-pilot-rag (containers deal-pilot-rag-<service>-1)'
Write-Host ('        services     : ' + ($coreServices -join ', '))
Write-Host '        It may serve other projects; stopping it breaks them too.'

if ($StatusOnly) {
    $ps = Invoke-NativeCapture -FilePath 'docker' -Arguments @('ps', '--filter', 'label=com.docker.compose.project=deal-pilot-rag', '--format', 'table {{.Names}}\t{{.Status}}\t{{.Ports}}')
    foreach ($line in $ps.Lines) { Write-Host $line }
    exit 0
}

if (-not $Force) {
    Write-Host ''
    Write-Host '[SKIP] middleware left running. Re-run with -Force to stop it.' -ForegroundColor Yellow
    Write-Host '       (docker compose stop keeps containers and volumes, so data survives.)'
    exit 0
}

if (-not (Test-Path -LiteralPath $RefCompose)) {
    Write-Host ('[FAIL] reference compose not found: ' + $RefCompose) -ForegroundColor Red
    exit 2
}

$arguments = @('compose', '-f', $RefCompose, 'stop')
foreach ($svc in $coreServices) { $arguments = $arguments + $svc }
$stopInfra = Invoke-NativeCapture -FilePath 'docker' -Arguments $arguments
foreach ($line in $stopInfra.Lines) { Write-Host $line }
Write-Host ('[infra] stop exit code: ' + $stopInfra.ExitCode)
Write-Host '[infra] data volumes untouched (use the reference project if you really need `down -v`).'
exit $stopInfra.ExitCode
