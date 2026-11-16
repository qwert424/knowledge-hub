# scripts/bootstrap.ps1
# Idempotent one-time setup for knowledge-hub. Safe to re-run.
#
#   1. start our own containers kh-postgres / kh-redis (if not running)
#   2. create the Milvus database  `knowledge_hub`      (pymilvus)
#   3. create the MinIO bucket     `knowledge-hub`      (mc inside shared-minio)
#   4. publish deploy/nacos/knowledge-hub.yaml to Nacos (dataId=knowledge-hub.yaml,
#      group=DEFAULT_GROUP, namespace=public)
#
# Nacos version note: v3.x (the version used by the reused stack) removed the v1/v2
# open APIs, so the write goes to POST /nacos/v3/admin/cs/config (falling back to
# /v3/console, /v1, /v2 for older servers). Namespace `public` is Nacos' empty
# tenant/namespaceId. Writing requires an ADMIN account: the built-in one is
# `nacos` with the password from NACOS_PASSWORD, which this script tries after
# NACOS_USERNAME.
#
# Usage:
#   .\scripts\bootstrap.ps1
#   .\scripts\bootstrap.ps1 -SkipContainers -SkipMilvus
#
# Nothing here is destructive: existing databases / buckets / configs are reused.

[CmdletBinding()]
param(
    [switch]$SkipContainers,
    [switch]$SkipMilvus,
    [switch]$SkipMinio,
    [switch]$SkipNacos,
    [string]$Python = '',
    [int]$WaitSeconds = 120
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -Quiet

$results = New-Object System.Collections.ArrayList

function Add-Result {
    param([string]$Step, [string]$Status, [string]$Detail)
    $null = $results.Add([pscustomobject]@{ Step = $Step; Status = $Status; Detail = $Detail })
    $color = 'Gray'
    if ($Status -eq 'OK') { $color = 'Green' }
    if ($Status -eq 'SKIP') { $color = 'Yellow' }
    if ($Status -eq 'FAIL') { $color = 'Red' }
    Write-Host ('[' + $Status + '] ' + $Step + ' - ' + $Detail) -ForegroundColor $color
}

function Test-DockerDaemon {
    $null = & docker info --format '{{.ServerVersion}}' 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    return $true
}

# Native tools (docker, python) write progress and warnings to stderr. With
# $ErrorActionPreference='Stop' PowerShell 5.1 turns redirected stderr into a
# terminating error, so every capture runs in a Continue scope.
function Invoke-NativeCapture {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$InputText = ''
    )
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

function Find-Python {
    param([string]$Explicit)
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        if (Test-Path -LiteralPath $Explicit) { return $Explicit }
    }
    $venv = Join-Path $env:KH_ROOT 'agent\.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $venv) { return $venv }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    return ''
}

Write-Host '=== knowledge-hub bootstrap ===' -ForegroundColor Cyan
Write-Host ('root      : ' + $env:KH_ROOT)
Write-Host ('milvus    : ' + $env:MILVUS_URI + ' (db ' + $env:MILVUS_DB_NAME + ')')
Write-Host ('minio     : ' + $env:MINIO_ENDPOINT + ' (bucket ' + $env:MINIO_BUCKET + ')')
Write-Host ('nacos     : ' + $env:NACOS_SERVER + ' (namespace ' + $env:NACOS_NAMESPACE + ')')
Write-Host ''

# --------------------------------------------------------------- 1. containers
if ($SkipContainers) {
    Add-Result 'kh-postgres / kh-redis' 'SKIP' 'skipped by -SkipContainers'
} elseif (-not (Test-DockerDaemon)) {
    Add-Result 'kh-postgres / kh-redis' 'FAIL' 'docker daemon unreachable - start Docker Desktop'
} else {
    $envFile = Join-Path $env:KH_ROOT '.env'
    $composeUp = Invoke-NativeCapture -FilePath 'docker' -Arguments @('compose', '--env-file', $envFile, '-f', $env:KH_COMPOSE_APP, 'up', '-d', 'kh-postgres', 'kh-redis')
    foreach ($line in $composeUp.Lines) { Write-Host ('    ' + $line) }
    if ($composeUp.ExitCode -ne 0) {
        Add-Result 'kh-postgres / kh-redis' 'FAIL' 'docker compose up failed (port conflict? run scripts/check-docker.ps1)'
    } else {
        $deadline = (Get-Date).AddSeconds($WaitSeconds)
        $pgHealth = 'unknown'
        $redisHealth = 'unknown'
        while ((Get-Date) -lt $deadline) {
            $pgHealth = (& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' kh-postgres 2>$null)
            $redisHealth = (& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' kh-redis 2>$null)
            if ($pgHealth -eq 'healthy' -and $redisHealth -eq 'healthy') { break }
            Start-Sleep -Seconds 2
        }
        if ($pgHealth -eq 'healthy' -and $redisHealth -eq 'healthy') {
            Add-Result 'kh-postgres / kh-redis' 'OK' ('healthy (' + $env:KH_PG_HOST + ':' + $env:KH_PG_PORT + ', ' + $env:KH_REDIS_HOST + ':' + $env:KH_REDIS_PORT + ')')
        } else {
            Add-Result 'kh-postgres / kh-redis' 'FAIL' ('postgres=' + $pgHealth + ' redis=' + $redisHealth + ' - check: docker logs kh-postgres')
        }
    }
}

# ------------------------------------------------------------------ 2. milvus
if ($SkipMilvus) {
    Add-Result ('milvus db ' + $env:MILVUS_DB_NAME) 'SKIP' 'skipped by -SkipMilvus'
} else {
    $dbName = $env:MILVUS_DB_NAME
    $milvusBase = $env:MILVUS_URI
    if ($milvusBase -notmatch '^https?://') { $milvusBase = 'http://' + $milvusBase }
    $milvusBase = $milvusBase.TrimEnd('/')

    $milvusDone = $false
    $milvusDetail = ''

    # a) pymilvus - the same client the engine uses
    $py = Find-Python -Explicit $Python
    if (-not [string]::IsNullOrWhiteSpace($py)) {
        $null = & $py -c 'import pymilvus' 2>$null
        if ($LASTEXITCODE -eq 0) {
            $pyScript = @'
import os
import sys

uri = os.environ.get("MILVUS_URI") or "http://127.0.0.1:19530"
name = os.environ.get("MILVUS_DB_NAME") or "knowledge_hub"

try:
    try:
        from pymilvus import MilvusClient

        client = MilvusClient(uri=uri)
        existing = list(client.list_databases())
        if name in existing:
            print("EXISTS " + name)
        else:
            client.create_database(db_name=name)
            print("CREATED " + name)
    except ImportError:
        from pymilvus import connections, db

        connections.connect(alias="bootstrap", uri=uri, timeout=10)
        existing = [d.name for d in db.list_database(using="bootstrap")]
        if name in existing:
            print("EXISTS " + name)
        else:
            db.create_database(name, using="bootstrap")
            print("CREATED " + name)
except Exception as exc:
    print("ERROR " + str(exc))
    sys.exit(1)
'@
            $pyRun = Invoke-NativeCapture -FilePath $py -Arguments @('-') -InputText $pyScript
            if ($pyRun.ExitCode -eq 0) {
                $milvusDone = $true
                $milvusDetail = 'pymilvus: ' + $pyRun.Output.Trim()
            }
        }
    }

    # b) Milvus RESTful v2 - works without any python dependency
    if (-not $milvusDone) {
        try {
            $listResp = Invoke-WebRequest -Uri ($milvusBase + '/v2/vectordb/databases/list') -Method Post -Body '{}' `
                -ContentType 'application/json' -UseBasicParsing -TimeoutSec 10
            $listJson = $listResp.Content | ConvertFrom-Json
            $existingDbs = @()
            if ($null -ne $listJson.data) { $existingDbs = @($listJson.data) }
            if ($existingDbs -contains $dbName) {
                $milvusDone = $true
                $milvusDetail = 'REST: database already exists'
            } else {
                $body = @{ dbName = $dbName } | ConvertTo-Json -Compress
                $createResp = Invoke-WebRequest -Uri ($milvusBase + '/v2/vectordb/databases/create') -Method Post `
                    -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 15
                $createJson = $createResp.Content | ConvertFrom-Json
                if ($null -ne $createJson.code -and [int]$createJson.code -eq 0) {
                    $milvusDone = $true
                    $milvusDetail = 'REST: database created'
                } else {
                    $milvusDetail = 'REST: ' + $createResp.Content
                }
            }
        } catch {
            $milvusDetail = 'REST: ' + $_.Exception.Message
            if ($milvusDetail -match 'already exist') { $milvusDone = $true }
        }
    }

    if ($milvusDone) {
        Add-Result ('milvus db ' + $dbName) 'OK' $milvusDetail
    } else {
        Add-Result ('milvus db ' + $dbName) 'FAIL' $milvusDetail
        Write-Host '    Manual step (choose one):' -ForegroundColor Yellow
        Write-Host '      python -m pip install pymilvus    (then re-run this script)'
        Write-Host ('      POST ' + $milvusBase + '/v2/vectordb/databases/create  body: {"dbName":"' + $dbName + '"}')
        Write-Host '      or use Attu / any Milvus client to create the database once.'
    }
}

# ------------------------------------------------------------------- 3. minio
if ($SkipMinio) {
    Add-Result ('minio bucket ' + $env:MINIO_BUCKET) 'SKIP' 'skipped by -SkipMinio'
} else {
    $bucket = $env:MINIO_BUCKET
    $container = 'deal-pilot-rag-shared-minio-1'
    $exists = & docker inspect --format '{{.State.Status}}' $container 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($exists)) {
        Add-Result ('minio bucket ' + $bucket) 'FAIL' ('container ' + $container + ' not found - start the reused stack first')
        Write-Host '    Manual step: use the MinIO console http://127.0.0.1:9003 and create the bucket.' -ForegroundColor Yellow
    } else {
        # mc ships inside that image; `local` is already aliased to the server itself.
        $sh = 'mc alias set kh http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb --ignore-existing kh/' + $bucket + ' >/dev/null && mc ls kh/' + $bucket + ' >/dev/null && echo MINIO_OK'
        $mcRun = Invoke-NativeCapture -FilePath 'docker' -Arguments @('exec', $container, 'sh', '-c', $sh)
        if ($mcRun.ExitCode -eq 0 -and $mcRun.Output -match 'MINIO_OK') {
            Add-Result ('minio bucket ' + $bucket) 'OK' ('present in ' + $container)
        } else {
            Add-Result ('minio bucket ' + $bucket) 'FAIL' $mcRun.Output.Trim()
            Write-Host '    Manual step: docker exec -it deal-pilot-rag-shared-minio-1 sh' -ForegroundColor Yellow
            Write-Host ('                 mc mb --ignore-existing local/' + $bucket)
        }
    }
}

# ------------------------------------------------------------------- 4. nacos
function Resolve-NacosNamespace {
    param([string]$Namespace)
    # Nacos identifies the public namespace with an EMPTY namespaceId; 'public' is its display name.
    if ([string]::IsNullOrWhiteSpace($Namespace)) { return '' }
    if ($Namespace -eq 'public') { return '' }
    return $Namespace
}

function Get-NacosSession {
    param([string]$Base, [string]$User, [string]$Pass)
    $paths = @('/nacos/v3/auth/user/login', '/nacos/v1/auth/login')
    foreach ($p in $paths) {
        try {
            $resp = Invoke-RestMethod -Uri ($Base + $p) -Method Post -TimeoutSec 10 `
                -ContentType 'application/x-www-form-urlencoded' `
                -Body @{ username = $User; password = $Pass }
            if ($null -ne $resp -and $null -ne $resp.accessToken) {
                $isAdmin = $false
                if ($null -ne $resp.globalAdmin) { $isAdmin = [bool]$resp.globalAdmin }
                return [pscustomobject]@{ User = $User; Token = [string]$resp.accessToken; GlobalAdmin = $isAdmin }
            }
        } catch {
            # try next login endpoint
        }
    }
    return $null
}

function Publish-NacosConfig {
    param([string]$Base, [string]$Token, [string]$DataId, [string]$Group, [string]$Namespace, [string]$Content)

    # Field names differ between the v3 and v1/v2 APIs.
    $attempts = @(
        @{ Path = '/nacos/v3/admin/cs/config';   GroupField = 'groupName'; NamespaceField = 'namespaceId' },
        @{ Path = '/nacos/v3/console/cs/config'; GroupField = 'groupName'; NamespaceField = 'namespaceId' },
        @{ Path = '/nacos/v1/cs/configs';        GroupField = 'group';     NamespaceField = 'tenant' },
        @{ Path = '/nacos/v2/cs/config';         GroupField = 'group';     NamespaceField = 'namespaceId' }
    )

    $errors = @()
    foreach ($attempt in $attempts) {
        $form = @{ dataId = $DataId; type = 'yaml'; content = $Content }
        $form[$attempt.GroupField] = $Group
        if (-not [string]::IsNullOrEmpty($Namespace)) { $form[$attempt.NamespaceField] = $Namespace }
        $uri = $Base + $attempt.Path
        if (-not [string]::IsNullOrEmpty($Token)) {
            $uri = $uri + '?accessToken=' + [uri]::EscapeDataString($Token)
        }
        try {
            $resp = Invoke-WebRequest -Uri $uri -Method Post -Body $form -TimeoutSec 20 -UseBasicParsing `
                -ContentType 'application/x-www-form-urlencoded'
            $text = [string]$resp.Content
            if ($text -match '"code":0' -or $text -match 'true') {
                return @{ Ok = $true; Detail = ($attempt.Path + ' -> ' + $text.Trim()) }
            }
            $errors = $errors + ($attempt.Path + ' -> HTTP ' + $resp.StatusCode + ' ' + $text.Trim())
        } catch {
            $errors = $errors + ($attempt.Path + ' -> ' + $_.Exception.Message)
        }
    }
    return @{ Ok = $false; Detail = ($errors -join ' | ') }
}

if ($SkipNacos) {
    Add-Result 'nacos config' 'SKIP' 'skipped by -SkipNacos'
} else {
    $nacosFile = Join-Path $env:KH_ROOT 'deploy\nacos\knowledge-hub.yaml'
    if (-not (Test-Path -LiteralPath $nacosFile)) {
        Add-Result 'nacos config' 'FAIL' ('missing ' + $nacosFile)
    } else {
        $base = $env:NACOS_SERVER.TrimEnd('/')
        $namespace = Resolve-NacosNamespace -Namespace $env:NACOS_NAMESPACE
        $content = Get-Content -LiteralPath $nacosFile -Raw -Encoding UTF8

        # Credential candidates: .env user first, then the Nacos 3 built-in admin `nacos`.
        $credCandidates = @()
        if (-not [string]::IsNullOrWhiteSpace($env:NACOS_USERNAME)) {
            $credCandidates = $credCandidates + , @($env:NACOS_USERNAME, $env:NACOS_PASSWORD)
        }
        if (-not [string]::IsNullOrWhiteSpace($env:NACOS_PASSWORD) -and $env:NACOS_USERNAME -ne 'nacos') {
            $credCandidates = $credCandidates + , @('nacos', $env:NACOS_PASSWORD)
        }

        $sessions = @()
        foreach ($cred in $credCandidates) {
            $session = Get-NacosSession -Base $base -User $cred[0] -Pass $cred[1]
            if ($null -ne $session) { $sessions = $sessions + $session }
        }
        $adminSessions = @($sessions | Where-Object { $_.GlobalAdmin })
        $otherSessions = @($sessions | Where-Object { -not $_.GlobalAdmin })
        $ordered = @()
        foreach ($s in $adminSessions) { $ordered = $ordered + $s }
        foreach ($s in $otherSessions) { $ordered = $ordered + $s }

        $done = $false
        $usedUser = ''
        $lastDetail = ''
        foreach ($session in $ordered) {
            $pub = Publish-NacosConfig -Base $base -Token $session.Token -DataId $env:NACOS_DATA_ID `
                -Group $env:NACOS_GROUP -Namespace $namespace -Content $content
            if ($pub.Ok) {
                $done = $true
                $usedUser = $session.User
                $lastDetail = $pub.Detail
                break
            }
            $lastDetail = $pub.Detail
        }

        if (-not $done) {
            # Auth-disabled server: write anonymously.
            $pub = Publish-NacosConfig -Base $base -Token '' -DataId $env:NACOS_DATA_ID `
                -Group $env:NACOS_GROUP -Namespace $namespace -Content $content
            if ($pub.Ok) {
                $done = $true
                $usedUser = '(anonymous)'
                $lastDetail = $pub.Detail
            } elseif ([string]::IsNullOrWhiteSpace($lastDetail)) {
                $lastDetail = $pub.Detail
            }
        }

        if ($done) {
            Add-Result 'nacos config' 'OK' ($env:NACOS_DATA_ID + ' / ' + $env:NACOS_GROUP + ' / namespace=' +
                $env:NACOS_NAMESPACE + ' as ' + $usedUser + ' (' + $lastDetail + ')')
        } else {
            Add-Result 'nacos config' 'FAIL' $lastDetail
            Write-Host '    Manual step: open http://127.0.0.1:8080 -> Config Management -> +' -ForegroundColor Yellow
            Write-Host ('                 dataId=' + $env:NACOS_DATA_ID + ' group=' + $env:NACOS_GROUP + ' format=YAML')
            Write-Host ('                 paste ' + $nacosFile)
            Write-Host '    Note: Nacos 3 needs an ADMIN account to publish. Set NACOS_USERNAME=nacos and'
            Write-Host '          NACOS_PASSWORD=<admin password> in .env, then re-run this script.'
        }
    }
}

# --------------------------------------------------------------------- summary
Write-Host ''
Write-Host '=== summary ===' -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String -Width 220 | Write-Host

$failed = @($results | Where-Object { $_.Status -eq 'FAIL' })
if ($failed.Count -gt 0) {
    Write-Host ('[FAIL] ' + $failed.Count + ' step(s) failed - see manual steps above.') -ForegroundColor Red
    exit 1
}
Write-Host '[OK] bootstrap complete. Next: .\scripts\dev.ps1' -ForegroundColor Green
exit 0
