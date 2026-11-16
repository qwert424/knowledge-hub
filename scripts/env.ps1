# scripts/env.ps1
# Loads the repo-root .env into the CURRENT process and exports defaults.
# Dot-source it (do not run it):
#   . .\scripts\env.ps1
#   . .\scripts\env.ps1 -Quiet
#   . .\scripts\env.ps1 -EnvFile C:\path\to\.env
#
# Dot-sourcing is what makes the variables visible to the caller; running the file
# as a script only affects a child process that immediately exits.
#
# Windows PowerShell 5.1 compatible: no &&, no ternary, no ?? operators.

[CmdletBinding()]
param(
    [string]$EnvFile = '',
    [string]$TempDir = '',
    [switch]$Quiet,
    [switch]$NoOverride
)

$khRootLocal = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $khRootLocal '.env'
}

# Child scripts inherit this so an opt-out survives one process hop.
if ($env:KH_ENV_NO_OVERRIDE -eq '1') { $NoOverride = $true }

# Snapshot of what the caller already had, so duplicate keys inside .env still
# resolve last-wins even under -NoOverride.
$khPreExistingKeys = @{}
if ($NoOverride) {
    foreach ($name in ([Environment]::GetEnvironmentVariables('Process').Keys)) {
        $khPreExistingKeys[[string]$name] = $true
    }
}

# ---------------------------------------------------------------- .env parsing
$loadedCount = 0
if (Test-Path -LiteralPath $EnvFile) {
    $lineNo = 0
    foreach ($rawLine in (Get-Content -LiteralPath $EnvFile -Encoding UTF8)) {
        $lineNo = $lineNo + 1
        $line = $rawLine.Trim()
        if ($line.Length -eq 0) { continue }
        if ($line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        # strip one layer of matching quotes
        if ($value.Length -ge 2) {
            $first = $value.Substring(0, 1)
            $last = $value.Substring($value.Length - 1, 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        # Windows env var names must match [A-Za-z_][A-Za-z0-9_]*
        if ($key -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            $skip = ($NoOverride -and $khPreExistingKeys.ContainsKey($key))
            if (-not $skip) {
                Set-Item -Path ('Env:' + $key) -Value $value
                $loadedCount = $loadedCount + 1
            }
        }
    }
} else {
    Write-Warning ("env.ps1: .env not found at " + $EnvFile + " (copy .env.example to .env)")
}

# ------------------------------------------------------------ scratch temp dir
# Keeps Maven / uv / pnpm / pip scratch files off the repo drive and out of
# antivirus-scanned user profile paths.
if ([string]::IsNullOrWhiteSpace($TempDir)) {
    if (-not [string]::IsNullOrWhiteSpace($env:KH_TEMP_DIR)) {
        $TempDir = $env:KH_TEMP_DIR
    } else {
        $TempDir = 'D:\devCaches\temp'
    }
}
if (-not (Test-Path -LiteralPath $TempDir)) {
    try {
        New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
    } catch {
        Write-Warning ("env.ps1: could not create temp dir " + $TempDir + " - using " + $env:TEMP)
        $TempDir = $env:TEMP
    }
}
$env:TEMP = $TempDir
$env:TMP = $TempDir

# --------------------------------------------------------------- repo anchors
$env:KH_ROOT = $khRootLocal
if ([string]::IsNullOrWhiteSpace($env:KH_REF_COMPOSE)) {
    # Reference RAG stack lives next to this repo (sibling directory);
    # deriving the path keeps this script free of hardcoded non-ASCII paths.
    $siblingRef = Join-Path (Split-Path -Parent $khRootLocal) 'ai-infrastructure-rag-practice\docker-compose.yml'
    $env:KH_REF_COMPOSE = $siblingRef
}
$env:KH_COMPOSE = Join-Path $khRootLocal 'deploy\compose\docker-compose.yml'

# ------------------------------------------------------------------- defaults
# Only filled in when missing/empty so .env always wins.
$khDefaults = [ordered]@{
    'APP_ENV'                     = 'local'
    'TZ'                          = 'Asia/Shanghai'
    'LOG_LEVEL'                   = 'INFO'
    'SERVER_PORT'                 = '8088'
    'BACKEND_BASE_URL'            = 'http://127.0.0.1:8088'
    'RAG_ENGINE_BASE_URL'         = 'http://127.0.0.1:8100'
    'AGENT_BASE_URL'              = 'http://127.0.0.1:8123'
    'NEXT_PUBLIC_API_BASE_URL'    = 'http://127.0.0.1:8088'
    'PORTAL_PORT'                 = '3100'
    'ADMIN_PORT'                  = '3101'
    'RAG_ENGINE_PORT'             = '8100'
    'KH_PG_HOST'                  = '127.0.0.1'
    'KH_PG_PORT'                  = '5433'
    'KH_PG_DB'                    = 'kh'
    'KH_PG_USER'                  = 'kh_app'
    'KH_PG_PASSWORD'              = 'kh_app_local'
    'KH_REDIS_HOST'               = '127.0.0.1'
    'KH_REDIS_PORT'               = '6380'
    'INTERNAL_SERVICE_TOKEN'      = 'internal-local-token'
    'MILVUS_URI'                  = 'http://127.0.0.1:19530'
    'MILVUS_DB_NAME'              = 'knowledge_hub'
    'NACOS_SERVER'                = 'http://127.0.0.1:8848'
    'NACOS_NAMESPACE'             = 'public'
    'NACOS_GROUP'                 = 'DEFAULT_GROUP'
    'NACOS_DATA_ID'               = 'knowledge-hub.yaml'
    'LITELLM_BASE_URL'            = 'http://127.0.0.1:4000/v1'
    'MINIO_ENDPOINT'              = 'http://127.0.0.1:9002'
    'MINIO_BUCKET'                = 'knowledge-hub'
    'MINIO_PUBLIC_ENDPOINT'       = 'http://127.0.0.1:9002'
    'NACOS_USERNAME'              = 'nacos'
    'NACOS_PASSWORD'              = '123456'
    'LANGFUSE_HOST'               = 'http://127.0.0.1:3000'
    'NEO4J_URI'                   = 'bolt://127.0.0.1:7687'
}
foreach ($key in $khDefaults.Keys) {
    $current = [Environment]::GetEnvironmentVariable($key, 'Process')
    if ([string]::IsNullOrEmpty($current)) {
        Set-Item -Path ('Env:' + $key) -Value $khDefaults[$key]
    }
}
Remove-Variable khDefaults -ErrorAction SilentlyContinue
Remove-Variable key -ErrorAction SilentlyContinue
Remove-Variable current -ErrorAction SilentlyContinue

# Do not export these two by accident: they are process-local scratch values.
Remove-Variable loadedCount -ErrorAction SilentlyContinue
Remove-Variable lineNo -ErrorAction SilentlyContinue
Remove-Variable rawLine -ErrorAction SilentlyContinue
Remove-Variable line -ErrorAction SilentlyContinue
Remove-Variable eq -ErrorAction SilentlyContinue
Remove-Variable value -ErrorAction SilentlyContinue
Remove-Variable first -ErrorAction SilentlyContinue
Remove-Variable last -ErrorAction SilentlyContinue

if (-not $Quiet) {
    Write-Host ("[env] root        : " + $env:KH_ROOT)
    Write-Host ("[env] .env        : " + $EnvFile)
    Write-Host ("[env] TEMP/TMP    : " + $env:TEMP)
    Write-Host ("[env] backend     : " + $env:BACKEND_BASE_URL)
    Write-Host ("[env] rag engine  : " + $env:RAG_ENGINE_BASE_URL)
    Write-Host ("[env] api (web)   : " + $env:NEXT_PUBLIC_API_BASE_URL)
}

