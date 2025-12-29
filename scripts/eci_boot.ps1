\
param(
  [string]$RedisName = "eci-redis"
)

Write-Host "==> Checking Docker Redis ($RedisName)..." -ForegroundColor Cyan

$running = docker ps --format "{{.Names}}" | Select-String -Quiet ("^" + [regex]::Escape($RedisName) + "$")
if (-not $running) {
  $exists = docker ps -a --format "{{.Names}}" | Select-String -Quiet ("^" + [regex]::Escape($RedisName) + "$")
  if ($exists) {
    docker start $RedisName | Out-Null
  } else {
    docker run -d --name $RedisName -p 6379:6379 redis:7-alpine | Out-Null
  }
}

Write-Host "==> Redis port test (127.0.0.1:6379)" -ForegroundColor Cyan
Test-NetConnection 127.0.0.1 -Port 6379
