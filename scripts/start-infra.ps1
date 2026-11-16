# scripts/start-infra.ps1
# Starts ONLY the reused middleware subset of the existing RAG stack
# (project `deal-pilot-rag`) - we never rebuild middleware.
#
#   Milvus (19530) + etcd + milvus-minio, shared MinIO (9002/9003),
#   Nacos (8848 / console 8080), LiteLLM (4000) [, Neo4j (7474/7687) with -WithNeo4j]
#
# Guideline: this script NEVER runs `down`, never runs `down -v`, never touches volumes.
#
# Usage:
#   .\scripts\start-infra.ps1
#   .\scripts\start-infra.ps1 -WithNeo4j
#   .\scripts\start-infra.ps1 -RefCompose D:\path\to\docker-compose.yml -WaitTimeout 600
#   .\scripts\start-infra.ps1 -StatusOnly

[CmdletBinding()]
param(
    [string]$RefCompose = '',
    [switch]$WithNeo4j,
    [switch]$StatusOnly,
    [int]$WaitTimeout = 420
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -Quiet

if ([string]::IsNullOrWhiteSpace($RefCompose)) {
    $RefCompose = $env:KH_REF_COMPOSE
}

$coreServices = @('milvus-etcd', 'milvus-minio', 'milvus', 'shared-minio', 'nacos', 'litellm')
$targets = @() + $coreServices
if ($WithNeo4j) { $targets = $targets + @('neo4j') }

function Invoke-NativeCapture {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$InputText = ''
    )
    # PS 5.1 turns redirected native stderr into a terminating error under
    # $ErrorActionPreference='Stop', so every docker call runs in a Continue scope.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ([string]::IsNullOrEmpty($InputText)) {
            $raw = & $FilePath @Arguments 2>&1
        } else {
            $raw = $InputText | & $FilePath @Arguments 2>&1
        }
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

function Get-ComposeProjectName {
    param([string]$File)
    $match = Select-String -LiteralPath $File -Pattern '^name:\s*(\S+)\s*$' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $match) { return $match.Matches[0].Groups[1].Value }
    return 'deal-pilot-rag'
}

function Show-InfraStatus {
    param([string]$Project, [string[]]$Services)
    $rows = @()
    foreach ($svc in $Services) {
        $name = $Project + '-' + $svc + '-1'
        $state = 'missing'
        $health = '-'
        $ports = ''
        $inspect = Invoke-NativeCapture -FilePath 'docker' -Arguments @('inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', $name)
        if ($inspect.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($inspect.Output)) {
            $parts = ($inspect.Output -split '\|')
            $state = $parts[0]
            if ($parts.Length -gt 1) { $health = $parts[1] }
        }
        $portInfo = Invoke-NativeCapture -FilePath 'docker' -Arguments @('port', $name)
        if ($portInfo.ExitCode -eq 0 -and $portInfo.Lines.Count -gt 0) {
            $ports = (($portInfo.Lines | ForEach-Object {
                $sides = $_ -split ' -> '
                if ($sides.Length -gt 1) { $sides[1] } else { $sides[0] }
            }) -join ', ')
        }
        $rows = $rows + [pscustomobject]@{
            Service  = $svc
            Container = $name
            State    = $state
            Health   = $health
            Ports    = $ports
        }
    }
    $rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
    return $rows
}

Write-Host '=== knowledge-hub infrastructure (reused stack) ===' -ForegroundColor Cyan
Write-Host ('compose file : ' + $RefCompose)
Write-Host ('extra hosts  : containers reach this stack through host.docker.internal')

if (-not (Test-Path -LiteralPath $RefCompose)) {
    Write-Host ('[FAIL] reference compose not found: ' + $RefCompose) -ForegroundColor Red
    Write-Host '       Pass -RefCompose <path> or set KH_REF_COMPOSE.'
    exit 2
}

$project = Get-ComposeProjectName -File $RefCompose
Write-Host ('compose project : ' + $project)

if (-not (Test-DockerDaemon)) {
    Write-Host '[FAIL] Docker daemon is not reachable.' -ForegroundColor Red
    Write-Host '       Start Docker Desktop and re-run. Nothing was changed.'
    exit 2
}

if ($StatusOnly) {
    $null = Show-InfraStatus -Project $project -Services $targets
    exit 0
}

$composeArgs = @('compose', '-f', $RefCompose)
if ($WithNeo4j) { $composeArgs = $composeArgs + @('--profile', 'neo4j') }
$composeArgs = $composeArgs + @('up', '-d', '--wait', '--wait-timeout', [string]$WaitTimeout)
$composeArgs = $composeArgs + $targets

Write-Host ''
Write-Host ('docker ' + ($composeArgs -join ' ')) -ForegroundColor DarkGray
$up = Invoke-NativeCapture -FilePath 'docker' -Arguments $composeArgs
foreach ($line in $up.Lines) { Write-Host $line }
$exit = $up.ExitCode

Write-Host ''
$rows = Show-InfraStatus -Project $project -Services $targets

if ($exit -ne 0) {
    Write-Host ('[WARN] docker compose exited with code ' + $exit + ' (a service may still be starting).') -ForegroundColor Yellow
    Write-Host '       Re-check with: .\scripts\start-infra.ps1 -StatusOnly'
    Write-Host '       Logs        : docker compose -f <ref> logs --tail 100 <service>'
}

$unhealthy = @($rows | Where-Object { $_.State -ne 'running' -or ($_.Health -ne 'healthy' -and $_.Health -ne 'none' -and $_.Health -ne '-') })
Write-Host ''
if ($unhealthy.Count -eq 0) {
    Write-Host '[OK] reused middleware is up. Next: .\scripts\bootstrap.ps1' -ForegroundColor Green
    exit 0
}

Write-Host ('[WARN] not ready yet: ' + (($unhealthy | ForEach-Object { $_.Service }) -join ', ')) -ForegroundColor Yellow
Write-Host '       Milvus can take 90s+ on first start; re-run -StatusOnly to poll.'
exit $exit
