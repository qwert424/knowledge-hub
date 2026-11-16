<#
.SYNOPSIS
  启动知识库平台（单一 compose 项目 knowledge-hub）。

.DESCRIPTION
  1. 若旧项目 deal-pilot-rag 在跑，先停掉（两者共用同一批数据卷与端口，不能并存）。
  2. 用 deploy/compose/docker-compose.yml 启动中间件 + 本项目应用。
  3. 所有容器 restart="no"，不会开机自启。

.PARAMETER InfraOnly
  只启动中间件（milvus / nacos / litellm / shared-minio 等），不启动 kh-* 应用。

.PARAMETER WithGraph
  额外启动 Neo4j（仅精选文档图谱需要）。

.PARAMETER WithObservability
  额外启动 Langfuse（LLM 追踪）。

.EXAMPLE
  pwsh scripts/up.ps1
  pwsh scripts/up.ps1 -InfraOnly -WithGraph
#>
[CmdletBinding()]
param(
  [switch]$InfraOnly,
  [switch]$WithGraph,
  [switch]$WithObservability,
  [switch]$SkipOldProjectStop
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'env.ps1')
$composeFile = Join-Path $repoRoot 'deploy/compose/docker-compose.yml'

if (-not (Test-Path $composeFile)) { throw "找不到 $composeFile" }

# ---- 1. 旧项目不能与本项目同时占用卷/端口 ----
if (-not $SkipOldProjectStop) {
  $running = (docker compose ls --format json 2>$null | ConvertFrom-Json) | Where-Object { $_.Name -eq 'deal-pilot-rag' -and $_.Status -match 'running' }
  if ($running) {
    Write-Host '[i] 检测到旧的 deal-pilot-rag 正在运行，先停止（数据卷保留，配置不丢）...' -ForegroundColor Yellow
    docker compose -p deal-pilot-rag stop | Out-Null
  }
}

# ---- 2. 组装 profile ----
$profiles = @('infra')
if (-not $InfraOnly) { $profiles += 'app' }
if ($WithGraph) { $profiles += 'graph' }
if ($WithObservability) { $profiles += 'observability' }

$argsList = @('compose', '--env-file', (Join-Path $repoRoot '.env'), '-f', $composeFile)
foreach ($p in $profiles) { $argsList += @('--profile', $p) }
$argsList += @('up', '-d', '--wait')

Write-Host ("[i] docker " + ($argsList -join ' ')) -ForegroundColor DarkGray
& docker @argsList
if ($LASTEXITCODE -ne 0) { throw "docker compose up 失败（退出码 $LASTEXITCODE）" }

Write-Host ''
Write-Host '启动完成：' -ForegroundColor Green
if (-not $InfraOnly) {
  "  用户端   http://127.0.0.1:$env:PORTAL_PORT"
  "  管理端   http://127.0.0.1:$env:ADMIN_PORT   (admin / Admin@12345)"
  "  后端     http://127.0.0.1:$env:SERVER_PORT/actuator/health"
  "  RAG 引擎 http://127.0.0.1:$env:RAG_ENGINE_PORT/health"
}
"  管理中间件 Nacos    http://127.0.0.1:8848  (控制台 :8080, nacos / 123456)"
"  LiteLLM 网关        http://127.0.0.1:4000  (模型清单 /v1/models)"
"  MinIO 控制台        http://127.0.0.1:9003"
if ($WithObservability) { "  Langfuse            http://127.0.0.1:3000" }