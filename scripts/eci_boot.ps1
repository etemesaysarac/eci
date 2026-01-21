<#
ECI Boot Script (Windows / PowerShell)

Goal: Make "PC restart -> API/Worker dead" go away.

What it does:
1) Ensures Docker is reachable (Docker Desktop must be running).
2) Brings up infra via docker compose (postgres + redis).
3) Prints a short health snapshot (docker ps + port tests).

Usage (from repo root):
  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/eci_boot.ps1

Optional:
  -RepoRoot "C:\dev\eci"
#>

param(
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

function Say([string]$msg) {
  Write-Host $msg -ForegroundColor Cyan
}

if (-not $RepoRoot -or $RepoRoot.Trim() -eq "") {
  # scripts/.. = repo root
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$composeFile = Join-Path $RepoRoot "infra\docker-compose.yml"

Say "==> RepoRoot: $RepoRoot"
Say "==> Checking Docker engine..."

try {
  docker info | Out-Null
} catch {
  Write-Host "Docker engine'a ulasilamiyor. Docker Desktop acik degil gibi." -ForegroundColor Yellow
  Write-Host "1) Docker Desktop'i ac" -ForegroundColor Yellow
  Write-Host "2) Tekrar calistir: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/eci_boot.ps1" -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path $composeFile)) {
  Write-Host "infra/docker-compose.yml bulunamadi: $composeFile" -ForegroundColor Red
  exit 1
}

Say "==> Bringing up infra (postgres + redis) via docker compose..."
pushd (Join-Path $RepoRoot "infra")
try {
  docker compose up -d
} finally {
  popd
}

Say "==> docker ps (infra)"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | Select-String -Pattern "infra-" -SimpleMatch

Say "==> Port tests"
Test-NetConnection 127.0.0.1 -Port 5432 | Out-Host
Test-NetConnection 127.0.0.1 -Port 6379 | Out-Host

Write-Host "\nOK. Infra hazir. Sonraki adimlar:" -ForegroundColor Green
Write-Host "  - DB migration (once): npm -w @eci/core run prisma:deploy" -ForegroundColor Green
Write-Host "  - API:                npm run eci:api" -ForegroundColor Green
Write-Host "  - Worker:             npm run eci:worker" -ForegroundColor Green
