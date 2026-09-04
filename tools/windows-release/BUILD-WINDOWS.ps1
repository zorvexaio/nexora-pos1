param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
Set-Location $Root

Write-Host "Nexora POS Windows Release Builder" -ForegroundColor Cyan
Write-Host "Project: $Root"

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

Require-Command node
Require-Command npm

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) { throw "Node.js 22+ is required. Detected: $(node -v)" }

Write-Host "[1/7] Installing pinned dependencies..." -ForegroundColor Yellow
npm ci --no-audit --no-fund

Write-Host "[2/7] Rebuilding native SQLite dependency..." -ForegroundColor Yellow
npm run rebuild

Write-Host "[3/7] Running native SQLite runtime probe..." -ForegroundColor Yellow
npm run verify:native

Write-Host "[4/7] Running complete verification suite..." -ForegroundColor Yellow
npm run check

Write-Host "[5/7] Running signed-release preflight..." -ForegroundColor Yellow
node tools/release-preflight.js --windows-signed

Write-Host "[6/7] Building Windows NSIS installer..." -ForegroundColor Yellow
npm run dist:win

$Dist = Join-Path $Root 'dist'
if (-not (Test-Path $Dist)) { throw "Dist directory was not created: $Dist" }
$Exe = Get-ChildItem $Dist -File -Filter '*.exe' | Sort-Object Length -Descending | Select-Object -First 1
if (-not $Exe) { throw "No Windows .exe installer was produced under '$Dist'." }

Write-Host "[7/7] Verifying signed installer artifact..." -ForegroundColor Yellow
Write-Host "Installer: $($Exe.FullName)"
Write-Host "Size: $([math]::Round($Exe.Length / 1MB, 2)) MB"
$Sig = Get-AuthenticodeSignature -LiteralPath $Exe.FullName
if ($Sig.Status -ne 'Valid') { throw "Installer Authenticode signature is not valid: $($Sig.Status)" }
Write-Host "Authenticode: Valid" -ForegroundColor Green

$Sha = Get-FileHash $Exe.FullName -Algorithm SHA256
$ShaPath = "$($Exe.FullName).sha256"
"$($Sha.Hash)  $($Exe.Name)" | Set-Content -Encoding ascii $ShaPath

Write-Host "SHA-256: $($Sha.Hash)" -ForegroundColor Green
Write-Host "Release build completed successfully." -ForegroundColor Green
