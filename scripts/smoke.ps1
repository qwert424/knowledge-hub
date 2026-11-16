# scripts/smoke.ps1
# End-to-end HTTP smoke test against a running knowledge-hub.
#
#   1. GET  <backend>/actuator/health
#   2. GET  <engine>/health
#   3. POST <backend>/api/v1/auth/login        (admin / Admin@12345)
#   4. GET  <backend>/api/v1/kbs               (Bearer token)
#   5. GET  <backend>/api/v1/metrics/overview  (Bearer token)
#
# Prints PASS/FAIL per step, exits 1 if any step fails.
#
# Usage:
#   .\scripts\smoke.ps1
#   .\scripts\smoke.ps1 -BackendUrl http://127.0.0.1:8088 -Verbose

[CmdletBinding()]
param(
    [string]$BackendUrl = '',
    [string]$AgentUrl = '',
    [string]$Username = 'admin',
    [string]$Password = 'Admin@12345',
    [int]$TimeoutSec = 20
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -Quiet

if ([string]::IsNullOrWhiteSpace($BackendUrl)) { $BackendUrl = $env:BACKEND_BASE_URL }
if ([string]::IsNullOrWhiteSpace($AgentUrl)) { $AgentUrl = $env:RAG_ENGINE_BASE_URL }
$BackendUrl = $BackendUrl.TrimEnd('/')
$AgentUrl = $AgentUrl.TrimEnd('/')

$results = New-Object System.Collections.ArrayList

function Add-Check {
    param([string]$Step, [string]$Status, [string]$Detail)
    $null = $results.Add([pscustomobject]@{ Step = $Step; Result = $Status; Detail = $Detail })
    $color = 'Red'
    if ($Status -eq 'PASS') { $color = 'Green' }
    if ($Status -eq 'WARN') { $color = 'Yellow' }
    Write-Host ('[' + $Status + '] ' + $Step + ' - ' + $Detail) -ForegroundColor $color
}

function Get-HealthVerdict {
    param([int]$StatusCode, $Json)
    # Returns @{ Status = PASS|WARN|FAIL; Text = '<status>' }
    $text = ''
    if ($null -ne $Json -and $null -ne $Json.status) { $text = [string]$Json.status }
    if ($StatusCode -ne 200) { return @{ Status = 'FAIL'; Text = ('HTTP ' + $StatusCode + ' status=' + $text) } }
    if ($text -eq 'ok' -or $text -eq 'UP' -or $text -eq 'healthy') {
        return @{ Status = 'PASS'; Text = ('HTTP ' + $StatusCode + ' status=' + $text) }
    }
    if ($text -eq 'degraded') {
        return @{ Status = 'WARN'; Text = ('HTTP ' + $StatusCode + ' status=degraded (partial dependencies, see /health body)') }
    }
    if ($text -eq '') {
        return @{ Status = 'PASS'; Text = ('HTTP ' + $StatusCode + ' (no status field)') }
    }
    return @{ Status = 'FAIL'; Text = ('HTTP ' + $StatusCode + ' status=' + $text) }
}

function Invoke-JsonRequest {
    param(
        [string]$Method,
        [string]$Uri,
        $Body = $null,
        [hashtable]$Headers = @{}
    )
    $params = @{
        Uri             = $Uri
        Method          = $Method
        TimeoutSec      = $TimeoutSec
        UseBasicParsing = $true
        Headers         = $Headers
    }
    if ($null -ne $Body) {
        $params['Body'] = ($Body | ConvertTo-Json -Depth 6 -Compress)
        $params['ContentType'] = 'application/json'
    }
    $resp = Invoke-WebRequest @params
    $parsed = $null
    try { $parsed = $resp.Content | ConvertFrom-Json } catch { $parsed = $null }
    return @{ StatusCode = [int]$resp.StatusCode; Content = $resp.Content; Json = $parsed }
}

Write-Host '=== knowledge-hub smoke ===' -ForegroundColor Cyan
Write-Host ('backend : ' + $BackendUrl)
Write-Host ('engine  : ' + $AgentUrl)
Write-Host ''

# ---------------------------------------------------------------- 1. backend
try {
    $r = Invoke-JsonRequest -Method GET -Uri ($BackendUrl + '/actuator/health')
    $verdict = Get-HealthVerdict -StatusCode $r.StatusCode -Json $r.Json
    Add-Check 'backend /actuator/health' $verdict.Status $verdict.Text
} catch {
    Add-Check 'backend /actuator/health' 'FAIL' $_.Exception.Message
}

# ------------------------------------------------------------------ 2. agent
try {
    $r = Invoke-JsonRequest -Method GET -Uri ($AgentUrl + '/health')
    $verdict = Get-HealthVerdict -StatusCode $r.StatusCode -Json $r.Json
    $extra = ''
    if ($null -ne $r.Json -and $null -ne $r.Json.errors) {
        $extra = ' :: ' + (($r.Json.errors | ForEach-Object { [string]$_ }) -join '; ')
    }
    Add-Check 'engine /health' $verdict.Status ($verdict.Text + $extra)
} catch {
    Add-Check 'engine /health' 'FAIL' $_.Exception.Message
}

# ------------------------------------------------------------------ 3. login
$token = ''
try {
    $r = Invoke-JsonRequest -Method POST -Uri ($BackendUrl + '/api/v1/auth/login') -Body @{ username = $Username; password = $Password }
    if ($null -ne $r.Json -and $null -ne $r.Json.data) {
        $data = $r.Json.data
        if ($null -ne $data.accessToken) { $token = [string]$data.accessToken }
        elseif ($null -ne $data.token) { $token = [string]$data.token }
        elseif ($null -ne $data.access_token) { $token = [string]$data.access_token }
    }
    $ok = ($r.StatusCode -eq 200 -and -not [string]::IsNullOrWhiteSpace($token))
    $detail = 'HTTP ' + $r.StatusCode
    if ($ok) {
        $shortToken = $token
        if ($shortToken.Length -gt 6) { $shortToken = $shortToken.Substring(0, 6) }
        $detail = $detail + ' token=' + $shortToken + '...'
    } else {
        $detail = $detail + ' no accessToken in response'
    }
    $loginStatus = 'FAIL'
    if ($ok) { $loginStatus = 'PASS' }
    Add-Check ('login ' + $Username) $loginStatus $detail
} catch {
    Add-Check ('login ' + $Username) 'FAIL' $_.Exception.Message
}

$authHeaders = @{}
if (-not [string]::IsNullOrWhiteSpace($token)) {
    $authHeaders['Authorization'] = 'Bearer ' + $token
}

# -------------------------------------------------------------------- 4. kbs
try {
    $r = Invoke-JsonRequest -Method GET -Uri ($BackendUrl + '/api/v1/kbs') -Headers $authHeaders
    $code = ''
    if ($null -ne $r.Json -and $null -ne $r.Json.code) { $code = [string]$r.Json.code }
    $ok = ($r.StatusCode -eq 200)
    if ($ok -and $code -ne '' -and $code -ne 'OK') { $ok = $false }
    $count = 'n/a'
    if ($null -ne $r.Json -and $null -ne $r.Json.data) {
        if ($r.Json.data -is [array]) { $count = [string]$r.Json.data.Count }
        elseif ($null -ne $r.Json.data.total) { $count = [string]$r.Json.data.total }
    }
    $kbsStatus = 'FAIL'
    if ($ok) { $kbsStatus = 'PASS' }
    Add-Check 'GET /api/v1/kbs' $kbsStatus ('HTTP ' + $r.StatusCode + ' code=' + $code + ' items=' + $count)
} catch {
    Add-Check 'GET /api/v1/kbs' 'FAIL' $_.Exception.Message
}

# ---------------------------------------------------------------- 5. metrics
try {
    $r = Invoke-JsonRequest -Method GET -Uri ($BackendUrl + '/api/v1/metrics/overview') -Headers $authHeaders
    $code = ''
    if ($null -ne $r.Json -and $null -ne $r.Json.code) { $code = [string]$r.Json.code }
    $ok = ($r.StatusCode -eq 200)
    if ($ok -and $code -ne '' -and $code -ne 'OK') { $ok = $false }
    $metricsStatus = 'FAIL'
    if ($ok) { $metricsStatus = 'PASS' }
    Add-Check 'GET /api/v1/metrics/overview' $metricsStatus ('HTTP ' + $r.StatusCode + ' code=' + $code)
} catch {
    Add-Check 'GET /api/v1/metrics/overview' 'FAIL' $_.Exception.Message
}

Write-Host ''
Write-Host '=== summary ===' -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

$failed = @($results | Where-Object { $_.Result -eq 'FAIL' })
$warned = @($results | Where-Object { $_.Result -eq 'WARN' })
if ($failed.Count -gt 0) {
    Write-Host ('[FAIL] ' + $failed.Count + ' of ' + $results.Count + ' checks failed.') -ForegroundColor Red
    Write-Host 'Hints:'
    Write-Host '  * backend not up      -> .\scripts\dev.ps1 -Only backend (or docker logs kh-backend)'
    Write-Host '  * engine not up       -> .\scripts\dev.ps1 -Only agent   (or docker logs kh-agent)'
    Write-Host '  * login 401           -> check the seeded admin account / password'
    Write-Host '  * middleware missing  -> .\scripts\start-infra.ps1 -StatusOnly'
    exit 1
}

if ($warned.Count -gt 0) {
    Write-Host ('[PASS] ' + ($results.Count - $warned.Count) + ' checks passed, ' + $warned.Count + ' warning(s).') -ForegroundColor Yellow
    Write-Host '       A degraded dependency is listed in the step detail above (engine /health body).'
    exit 0
}

Write-Host ('[PASS] all ' + $results.Count + ' checks passed.') -ForegroundColor Green
exit 0
