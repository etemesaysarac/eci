param(
  [string]$RepoDir = "C:\dev\eci",
  [string]$CoreDir = "C:\dev\eci\services\core",
  [int]$ApiPort = 3001
)

$ErrorActionPreference = "Stop"
$issues = New-Object System.Collections.Generic.List[string]

function Check-Cmd([string]$name, [string]$hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    $issues.Add("Eksik komut: $name. $hint")
    return $false
  }
  return $true
}

Write-Host "ECI Doctor 🩺" -ForegroundColor Cyan

if (-not (Test-Path $RepoDir))  { $issues.Add("Repo dizini yok: $RepoDir") }
if (-not (Test-Path $CoreDir))  { $issues.Add("Core dizini yok: $CoreDir") }

Check-Cmd node  "Node.js kurulu olmalı."
Check-Cmd npm   "NPM kurulu olmalı (Node ile gelir)."
Check-Cmd pwsh  "PowerShell 7 (pwsh) kurulu olmalı."
Check-Cmd docker "Docker Desktop kurulu/çalışıyor olmalı (infra için)."

if (Test-Path (Join-Path $CoreDir "package.json")) {
  try {
    $pkg = Get-Content (Join-Path $CoreDir "package.json") -Raw | ConvertFrom-Json
    $scripts = $pkg.scripts
    if (-not $scripts."eci:api")    { $issues.Add("package.json scripts içinde eci:api yok") }
    if (-not $scripts."eci:worker") { $issues.Add("package.json scripts içinde eci:worker yok") }
  } catch {
    $issues.Add("package.json parse edilemedi: $($_.Exception.Message)")
  }
} else {
  $issues.Add("package.json bulunamadı: $CoreDir\package.json")
}

# .env kontrolü (yalın uyarı)
$envCandidates = @(
  (Join-Path $CoreDir ".env"),
  (Join-Path $RepoDir ".env")
) | Where-Object { Test-Path $_ }

if ($envCandidates.Count -eq 0) {
  $issues.Add(".env bulunamadı (core/.env veya repo/.env).")
} else {
  Write-Host ("Bulunan .env: {0}" -f ($envCandidates -join ", ")) -ForegroundColor DarkGray
}

# Port kontrol
try {
  $listen = Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listen) {
    Write-Host ("Port {0} LISTEN (API çalışıyor olabilir)." -f $ApiPort) -ForegroundColor DarkGray
  } else {
    Write-Host ("Port {0} boş." -f $ApiPort) -ForegroundColor DarkGray
  }
} catch {}

if ($issues.Count -gt 0) {
  Write-Host "`n❌ Doctor FAIL" -ForegroundColor Red
  $issues | ForEach-Object { Write-Host ("- " + $_) -ForegroundColor Red }
  exit 1
}

Write-Host "`n✅ Doctor OK" -ForegroundColor Green
