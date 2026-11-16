# scripts/gen-secrets.ps1
# Generates the local secrets knowledge-hub needs and stores them OUTSIDE git:
#   secrets/jwt-private.pem   RSA-2048 private key (PKCS#8)
#   secrets/jwt-public.pem    matching public key (SPKI)
#   .env                      SECRET_MASTER_KEY (32 random bytes, base64)
#                             INTERNAL_SERVICE_TOKEN (32 random bytes, base64url)
#
# Rules:
#   * existing files are NEVER overwritten (re-run is a no-op)
#   * .env values are only filled in when currently empty/missing
#   * key generation order: openssl -> python `cryptography` -> pure-python RSA (slow, no deps)
#
# Usage:
#   .\scripts\gen-secrets.ps1
#   .\scripts\gen-secrets.ps1 -RotateEnvStrings   # also regenerate the two random strings in .env

[CmdletBinding()]
param(
    [switch]$RotateEnvStrings,   # regenerate SECRET_MASTER_KEY / INTERNAL_SERVICE_TOKEN even if set
    [int]$KeyBits = 2048,
    [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -Quiet

$secretsDir = Join-Path $env:KH_ROOT 'secrets'
if (-not (Test-Path -LiteralPath $secretsDir)) {
    New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null
}
$privPath = Join-Path $secretsDir 'jwt-private.pem'
$pubPath = Join-Path $secretsDir 'jwt-public.pem'

function New-RandomBytes {
    param([int]$Count)
    $bytes = New-Object 'byte[]' $Count
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return $bytes
}

# openssl writes progress dots and python writes warnings to stderr; PS 5.1 turns
# redirected native stderr into a terminating error while $ErrorActionPreference='Stop'.
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
    if (-not [string]::IsNullOrWhiteSpace($Explicit) -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }
    $venv = Join-Path $env:KH_ROOT 'agent\.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $venv) { return $venv }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    return ''
}

function Find-OpenSsl {
    $cmd = Get-Command openssl -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -ne $git) {
        $gitHome = Split-Path -Parent (Split-Path -Parent $git.Source)
        $candidates = @(
            (Join-Path $gitHome 'usr\bin\openssl.exe'),
            (Join-Path $gitHome 'mingw64\bin\openssl.exe')
        )
        foreach ($c in $candidates) {
            if (Test-Path -LiteralPath $c) { return $c }
        }
    }
    $fallbacks = @(
        'C:\Program Files\OpenSSL-Win64\bin\openssl.exe',
        'C:\Program Files\Git\usr\bin\openssl.exe'
    )
    foreach ($c in $fallbacks) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return ''
}

$openssl = Find-OpenSsl
$python = Find-Python -Explicit $Python

# ---------------------------------------------------------------- RSA keypair
if (Test-Path -LiteralPath $privPath) {
    Write-Host ('[skip] private key exists : ' + $privPath) -ForegroundColor Yellow
} else {
    $generated = $false
    if (-not [string]::IsNullOrWhiteSpace($openssl)) {
        Write-Host ('[key ] openssl: ' + $openssl)
        $genKey = Invoke-NativeCapture -FilePath $openssl -Arguments @('genpkey', '-algorithm', 'RSA', '-pkeyopt', ('rsa_keygen_bits:' + $KeyBits), '-out', $privPath)
        if ($genKey.ExitCode -eq 0 -and (Test-Path -LiteralPath $privPath)) {
            $genPub = Invoke-NativeCapture -FilePath $openssl -Arguments @('rsa', '-in', $privPath, '-pubout', '-out', $pubPath)
            if ($genPub.ExitCode -eq 0 -and (Test-Path -LiteralPath $pubPath)) { $generated = $true }
        }
        if (-not $generated) {
            Write-Host '[warn] openssl keygen failed - falling back to python' -ForegroundColor Yellow
            if (Test-Path -LiteralPath $privPath) { Remove-Item -LiteralPath $privPath -Force }
            if (Test-Path -LiteralPath $pubPath) { Remove-Item -LiteralPath $pubPath -Force }
        }
    }

    if (-not $generated -and -not [string]::IsNullOrWhiteSpace($python)) {
        $cryptoScript = @'
import sys

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
except Exception:
    sys.exit(3)

bits = int(sys.argv[3])
key = rsa.generate_private_key(public_exponent=65537, key_size=bits)
with open(sys.argv[1], "wb") as fh:
    fh.write(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
with open(sys.argv[2], "wb") as fh:
    fh.write(key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ))
print("PY_CRYPTO_OK")
'@
        Write-Host '[key ] python cryptography ...'
        $pyCrypto = Invoke-NativeCapture -FilePath $python -Arguments @('-', $privPath, $pubPath, [string]$KeyBits) -InputText $cryptoScript
        if ($pyCrypto.ExitCode -eq 0 -and $pyCrypto.Output -match 'PY_CRYPTO_OK') {
            $generated = $true
        } else {
            if (Test-Path -LiteralPath $privPath) { Remove-Item -LiteralPath $privPath -Force }
            if (Test-Path -LiteralPath $pubPath) { Remove-Item -LiteralPath $pubPath -Force }
        }
    }

    if (-not $generated -and -not [string]::IsNullOrWhiteSpace($python)) {
        # Last resort: pure-python RSA (no third-party modules, slower: a few seconds).
        $pureScript = @'
import base64
import secrets
import sys

PRIMES = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43)


def is_probable_prime(n, rounds=24):
    if n < 2:
        return False
    for p in PRIMES:
        if n % p == 0:
            return n == p
    d = n - 1
    r = 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x == 1 or x == n - 1:
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def gen_prime(bits):
    while True:
        candidate = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if is_probable_prime(candidate):
            return candidate


def der_len(n):
    if n < 0x80:
        return bytes([n])
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(raw)]) + raw


def tlv(tag, body):
    return bytes([tag]) + der_len(len(body)) + body


def der_int(v):
    raw = v.to_bytes((v.bit_length() + 7) // 8 or 1, "big")
    if raw[0] & 0x80:
        raw = b"\x00" + raw
    return tlv(0x02, raw)


def der_seq(*parts):
    return tlv(0x30, b"".join(parts))


def pem(kind, der):
    b64 = base64.b64encode(der).decode("ascii")
    lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
    return "-----BEGIN {0}-----\n{1}\n-----END {0}-----\n".format(kind, "\n".join(lines))


def main():
    priv_path, pub_path, bits = sys.argv[1], sys.argv[2], int(sys.argv[3])
    e = 65537
    while True:
        p = gen_prime(bits // 2)
        q = gen_prime(bits // 2)
        if p == q:
            continue
        phi = (p - 1) * (q - 1)
        if phi % e != 0:
            break
    n = p * q
    d = pow(e, -1, phi)
    if p < q:
        p, q = q, p

    rsa_private = der_seq(
        der_int(0), der_int(n), der_int(e), der_int(d),
        der_int(p), der_int(q), der_int(d % (p - 1)), der_int(d % (q - 1)),
        der_int(pow(q, -1, p)),
    )
    oid = bytes([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01])
    alg_id = der_seq(tlv(0x06, oid), tlv(0x05, b""))
    pkcs8 = der_seq(der_int(0), alg_id, tlv(0x04, rsa_private))
    spki = der_seq(alg_id, tlv(0x03, b"\x00" + der_seq(der_int(n), der_int(e))))

    with open(priv_path, "w", encoding="ascii", newline="\n") as fh:
        fh.write(pem("PRIVATE KEY", pkcs8))
    with open(pub_path, "w", encoding="ascii", newline="\n") as fh:
        fh.write(pem("PUBLIC KEY", spki))
    print("PURE_PY_OK")


main()
'@
        Write-Host '[key ] pure-python RSA (may take ~10-60s) ...'
        $pyPure = Invoke-NativeCapture -FilePath $python -Arguments @('-', $privPath, $pubPath, [string]$KeyBits) -InputText $pureScript
        if ($pyPure.ExitCode -eq 0 -and $pyPure.Output -match 'PURE_PY_OK') {
            $generated = $true
        } else {
            Write-Host ('[fail] pure-python keygen: ' + $pyPure.Output) -ForegroundColor Red
            if (Test-Path -LiteralPath $privPath) { Remove-Item -LiteralPath $privPath -Force }
            if (Test-Path -LiteralPath $pubPath) { Remove-Item -LiteralPath $pubPath -Force }
        }
    }

    if ($generated) {
        Write-Host ('[ok  ] private key written : ' + $privPath) -ForegroundColor Green
        Write-Host ('[ok  ] public key written  : ' + $pubPath) -ForegroundColor Green
    } else {
        Write-Host '[fail] could not generate the RSA keypair automatically.' -ForegroundColor Red
        Write-Host '       Install OpenSSL, or run: python -m pip install cryptography'
        Write-Host ('       Then: openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:' + $KeyBits + ' -out "' + $privPath + '"')
        Write-Host ('             openssl rsa -in "' + $privPath + '" -pubout -out "' + $pubPath + '"')
    }
}

if ((Test-Path -LiteralPath $privPath) -and -not (Test-Path -LiteralPath $pubPath)) {
    Write-Host '[key ] deriving missing public key ...'
    $derived = $false
    if (-not [string]::IsNullOrWhiteSpace($openssl)) {
        $deriveOpenSsl = Invoke-NativeCapture -FilePath $openssl -Arguments @('rsa', '-in', $privPath, '-pubout', '-out', $pubPath)
        if ($deriveOpenSsl.ExitCode -eq 0 -and (Test-Path -LiteralPath $pubPath)) { $derived = $true }
    }
    if (-not $derived -and -not [string]::IsNullOrWhiteSpace($python)) {
        $deriveScript = @'
import sys

from cryptography.hazmat.primitives import serialization

with open(sys.argv[1], "rb") as fh:
    key = serialization.load_pem_private_key(fh.read(), password=None)
with open(sys.argv[2], "wb") as fh:
    fh.write(key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ))
print("DERIVED")
'@
        $pyDerive = Invoke-NativeCapture -FilePath $python -Arguments @('-', $privPath, $pubPath) -InputText $deriveScript
        if ($pyDerive.ExitCode -eq 0 -and $pyDerive.Output -match 'DERIVED') { $derived = $true }
    }
    if ($derived) {
        Write-Host ('[ok  ] public key derived  : ' + $pubPath) -ForegroundColor Green
    } else {
        Write-Host '[warn] could not derive jwt-public.pem from the existing private key.' -ForegroundColor Yellow
        Write-Host ('       Run: openssl rsa -in "' + $privPath + '" -pubout -out "' + $pubPath + '"')
    }
}

# ------------------------------------------------------- random env secrets
function New-Base64Url {
    param([byte[]]$Bytes)
    return ([Convert]::ToBase64String($Bytes)).TrimEnd([char]'=').Replace('+', '-').Replace('/', '_')
}

$envPath = Join-Path $env:KH_ROOT '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    $example = Join-Path $env:KH_ROOT '.env.example'
    if (Test-Path -LiteralPath $example) {
        Copy-Item -LiteralPath $example -Destination $envPath
        Write-Host ('[env ] created .env from .env.example') -ForegroundColor Yellow
    } else {
        New-Item -ItemType File -Path $envPath | Out-Null
        Write-Host '[env ] created empty .env' -ForegroundColor Yellow
    }
}

$envLines = New-Object System.Collections.Generic.List[string]
foreach ($l in [System.IO.File]::ReadAllLines($envPath)) { $envLines.Add($l) }

function Get-EnvValueFromLines {
    param($Lines, [string]$Key)
    foreach ($line in $Lines) {
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith('#') -or $trimmed.Length -eq 0) { continue }
        $eq = $trimmed.IndexOf('=')
        if ($eq -lt 1) { continue }
        if ($trimmed.Substring(0, $eq).Trim() -eq $Key) {
            return $trimmed.Substring($eq + 1).Trim()
        }
    }
    return ''
}

function Set-EnvValueInLines {
    param($Lines, [string]$Key, [string]$Value)
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $trimmed = $Lines[$i].Trim()
        if ($trimmed.StartsWith('#') -or $trimmed.Length -eq 0) { continue }
        $eq = $trimmed.IndexOf('=')
        if ($eq -lt 1) { continue }
        if ($trimmed.Substring(0, $eq).Trim() -eq $Key) {
            $Lines[$i] = $Key + '=' + $Value
            return $true
        }
    }
    $Lines.Add($Key + '=' + $Value)
    return $false
}

$masterKey = (New-RandomBytes -Count 32)
$masterKeyB64 = [Convert]::ToBase64String($masterKey)
$internalToken = New-Base64Url -Bytes (New-RandomBytes -Count 32)

$changed = $false

$existingMaster = Get-EnvValueFromLines -Lines $envLines -Key 'SECRET_MASTER_KEY'
if ([string]::IsNullOrWhiteSpace($existingMaster) -or $RotateEnvStrings) {
    $null = Set-EnvValueInLines -Lines $envLines -Key 'SECRET_MASTER_KEY' -Value $masterKeyB64
    Write-Host '[env ] SECRET_MASTER_KEY set (32 bytes, base64)' -ForegroundColor Green
    $changed = $true
} else {
    Write-Host '[skip] SECRET_MASTER_KEY already set in .env'
}

$existingToken = Get-EnvValueFromLines -Lines $envLines -Key 'INTERNAL_SERVICE_TOKEN'
if ([string]::IsNullOrWhiteSpace($existingToken) -or $RotateEnvStrings) {
    $null = Set-EnvValueInLines -Lines $envLines -Key 'INTERNAL_SERVICE_TOKEN' -Value $internalToken
    Write-Host '[env ] INTERNAL_SERVICE_TOKEN set' -ForegroundColor Green
    $changed = $true
} else {
    Write-Host '[skip] INTERNAL_SERVICE_TOKEN already set in .env'
}

if ($changed) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($envPath, $envLines, $utf8NoBom)
    Write-Host ('[ok  ] updated ' + $envPath)
}

# ------------------------------------------------------------------- summary
Write-Host ''
Write-Host '=== secrets summary ===' -ForegroundColor Cyan
if (Test-Path -LiteralPath $privPath) { Write-Host ('jwt private : ' + $privPath) } else { Write-Host 'jwt private : MISSING' -ForegroundColor Red }
if (Test-Path -LiteralPath $pubPath) { Write-Host ('jwt public  : ' + $pubPath) } else { Write-Host 'jwt public  : MISSING' -ForegroundColor Red }
$finalMaster = Get-EnvValueFromLines -Lines ([System.IO.File]::ReadAllLines($envPath)) -Key 'SECRET_MASTER_KEY'
$finalToken = Get-EnvValueFromLines -Lines ([System.IO.File]::ReadAllLines($envPath)) -Key 'INTERNAL_SERVICE_TOKEN'
if ($finalMaster.Length -gt 8) {
    Write-Host ('SECRET_MASTER_KEY         : ' + $finalMaster.Substring(0, 4) + '...' + $finalMaster.Substring($finalMaster.Length - 4))
}
if ($finalToken.Length -gt 8) {
    Write-Host ('INTERNAL_SERVICE_TOKEN    : ' + $finalToken.Substring(0, 4) + '...' + $finalToken.Substring($finalToken.Length - 4))
}
Write-Host ''
Write-Host 'secrets/ and .env are gitignored - never commit them.' -ForegroundColor Yellow
