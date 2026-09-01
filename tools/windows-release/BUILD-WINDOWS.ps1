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

Write-Host "[1/6] Installing pinned dependencies..." -ForegroundColor Yellow
npm install --no-audit --no-fund

Write-Host "[2/6] Rebuilding native SQLite dependency..." -ForegroundColor Yellow
npm run rebuild

Write-Host "[3/6] Running complete verification suite..." -ForegroundColor Yellow
npm run check

Write-Host "[4/6] Running release preflight..." -ForegroundColor Yellow
node tools/release-preflight.js

Write-Host "[5/6] Building Windows NSIS installer..." -ForegroundColor Yellow
npm run dist:win

$Dist = Join-Path $Root 'dist'
if (-not (Test-Path $Dist)) { throw "Dist directory was not created: $Dist" }
$Exe = Get-ChildItem $Dist -File -Filter '*.exe' | Sort-Object Length -Descending | Select-Object -First 1
if (-not $Exe) { throw "No Windows .exe installer was produced under '$Dist'." }

Write-Host "[6/6] Verifying installer artifact..." -ForegroundColor Yellow
Write-Host "Installer: $($Exe.FullName)"
Write-Host "Size: $([math]::Round($Exe.Length / 1MB, 2)) MB"

$Sha = Get-FileHash $Exe.FullName -Algorithm SHA256
$ShaPath = "$($Exe.FullName).sha256"
"$($Sha.Hash)  $($Exe.Name)" | Set-Content -Encoding ascii $ShaPath

Write-Host "SHA-256: $($Sha.Hash)" -ForegroundColor Green
Write-Host "Release build completed successfully." -ForegroundColor Green
