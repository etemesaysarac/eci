param(
  [string]$CoreDir   = "C:\dev\eci\services\core",
  [string]$ApiLog    = "C:\dev\eci\api.log",
  [string]$WorkerLog = "C:\dev\eci\worker.log",
  [int]$ApiPort      = 3001
)

$ErrorActionPreference = "Stop"

function Get-ListeningProcess([int]$port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c) {
      $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      return @{ Port=$port; Pid=$c.OwningProcess; Name=($p.ProcessName) }
    }
  } catch {}
  return $null
}

if (-not (Test-Path $CoreDir)) {
  throw "Core dizini bulunamadı: $CoreDir"
}

$lp = Get-ListeningProcess -port $ApiPort
if ($lp) {
  Write-Host ("UYARI: {0} portu LISTEN. Pid={1} Name={2}. Zaten API çalışıyor olabilir; ikinci kez açmayacağım." -f $lp.Port, $lp.Pid, $lp.Name) -ForegroundColor Yellow
} else {
  Write-Host "API penceresi açılıyor..." -ForegroundColor Cyan
  $apiCmd = 'cd "{0}"; npm run eci:api 2>&1 | Tee-Object -FilePath "{1}"' -f $CoreDir, $ApiLog
  Start-Process -FilePath "pwsh" -ArgumentList @("-NoExit","-Command",$apiCmd) | Out-Null
}

Write-Host "Worker penceresi açılıyor..." -ForegroundColor Cyan
$workerCmd = 'cd "{0}"; npm run eci:worker 2>&1 | Tee-Object -FilePath "{1}"' -f $CoreDir, $WorkerLog
Start-Process -FilePath "pwsh" -ArgumentList @("-NoExit","-Command",$workerCmd) | Out-Null

Write-Host "`nReady ✅  (loglar: api.log / worker.log)" -ForegroundColor Green
