param(
  [Parameter(Mandatory=$true)][string]$Installer
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "Installer not found: $Installer" }
$Hash = Get-FileHash -LiteralPath $Installer -Algorithm SHA256
Write-Host "Installer: $Installer"
Write-Host "Size: $([math]::Round((Get-Item $Installer).Length/1MB,2)) MB"
Write-Host "SHA-256: $($Hash.Hash)"
