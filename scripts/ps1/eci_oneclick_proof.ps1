param(
  [string]$BaseUrl = "http://127.0.0.1:3001",
  [Parameter(Mandatory=$true)][string]$ConnectionId,
  [Parameter(Mandatory=$true)][string]$PackageId,
  [Parameter(Mandatory=$true)][long]$LineId,
  [switch]$SkipUnsupplied,
  [string]$WorkerLogPath = "C:\dev\eci\worker.log",
  [string]$ActionsTranscriptPath = "C:\dev\eci\Çıktılar.txt",
  [switch]$StartServices
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Port-Listening([int]$port) {
  try { return (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1) -ne $null }
  catch { return $false }
}

Write-Host "ECI One-Click Proof 🚀" -ForegroundColor Cyan

# Repo root'a geç (scripts\ps1 -> scripts -> repo)
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

# 1) Doctor
pwsh -ExecutionPolicy Bypass -File .\scripts\ps1\eci_doctor.ps1

# Fail-fast: API yoksa bu koşu anlamsız (HTTP 0 üretir)
if (-not (Port-Listening 3001) -and -not $StartServices) {
  throw "API 3001 dinlemiyor. -StartServices ver ya da önce eci_run.ps1 ile API'yi başlat."
}
# 2) Opsiyonel servis başlat
if ($StartServices -and -not (Port-Listening 3001)) {
  pwsh -ExecutionPolicy Bypass -File .\scripts\ps1\eci_run.ps1
} else {
  Write-Host "Servisler zaten çalışıyor (veya StartServices verilmedi)." -ForegroundColor DarkGray
}

# 3) Actions test
$test = ".\scripts\ps1\test_sprint7_2_actions.ps1"
if (-not (Test-Path $test)) { throw "Eksik: $test" }

$testArgs = @(
  "-BaseUrl", $BaseUrl,
  "-ConnectionId", $ConnectionId,
  "-PackageId", $PackageId,
  "-LineId", $LineId
)
if ($SkipUnsupplied) { $testArgs += "-SkipUnsupplied" }

Write-Host "`n== Running actions test ==" -ForegroundColor Cyan
pwsh -ExecutionPolicy Bypass -File $test @testArgs

# 4) Proof generate
$proof = ".\scripts\ps1\generate_sprint7_2_proof.ps1"
if (-not (Test-Path $proof)) { throw "Eksik: $proof" }

Write-Host "`n== Generating proof pack ==" -ForegroundColor Cyan
pwsh -ExecutionPolicy Bypass -File $proof `
  -BaseUrl $BaseUrl `
  -ConnectionId $ConnectionId `
  -PackageId $PackageId `
  -LineId $LineId `
  -WorkerLogPath $WorkerLogPath `
  -ActionsTranscriptPath $ActionsTranscriptPath

Write-Host "`nDONE ✅" -ForegroundColor Green

