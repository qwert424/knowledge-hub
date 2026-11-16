<#
.SYNOPSIS  停止知识库平台全部容器（保留数据卷）。
#>
[CmdletBinding()]
param([switch]$RemoveVolumes)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot 'deploy/compose/docker-compose.yml'

$argsList = @('compose', '--env-file', (Join-Path $repoRoot '.env'), '-f', $composeFile,
  '--profile', 'infra', '--profile', 'app', '--profile', 'graph', '--profile', 'observability', 'down')
if ($RemoveVolumes) {
  Write-Host '[!] -RemoveVolumes 会删除本项目自有卷 kh_pg_data / kh_redis_data（不动中间件卷）' -ForegroundColor Yellow
  $argsList += @('-v', '--remove-orphans')
}
& docker @argsList
if ($LASTEXITCODE -ne 0) { throw "docker compose down 失败" }
Write-Host '已停止。' -ForegroundColor Green