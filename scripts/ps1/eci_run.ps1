param(
  [Parameter(Mandatory=$false)]
  [string]$CoreDir = "C:\dev\eci\services\core",

  [Parameter(Mandatory=$false)]
  [int]$ApiPort = 3001,

  [Parameter(Mandatory=$false)]
  [string]$ApiLog = "C:\dev\eci\api.log",

  [Parameter(Mandatory=$false)]
  [string]$WorkerLog = "C:\dev\eci\worker.log",

  [Parameter(Mandatory=$false)]
  [string]$EnvFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if(!(Test-Path -LiteralPath $CoreDir)){
  throw "CoreDir bulunamadı: $CoreDir"
}

function Start-ECIProcess {
  param(
    [string]$Name,
    [string]$Cmd
  )
  $envPart = ""
  if($EnvFile -and (Test-Path -LiteralPath $EnvFile)){
    # npm script'lerin içindeki dotenv load mekanizmasına ek olarak destek
    $envPart = "`$env:ECI_ENV_FILE = '$EnvFile'; "
  }

  $psCommand = "cd '$CoreDir'; $envPart $Cmd 2>&1 | Tee-Object -FilePath '$($Name)'"
  # PowerShell pencere başlığı için
  $argList = @(
    "-NoExit",
    "-Command",
    $psCommand
  )

  # Log yolu gelen parametreye göre seç
  $logPath = if($Name -eq "API"){ $ApiLog } else { $WorkerLog }
  $psCommand = "cd '$CoreDir'; $envPart $Cmd 2>&1 | Tee-Object -FilePath '$logPath'"
  $argList = @("-NoExit","-Command",$psCommand)

  Start-Process -FilePath "pwsh" -ArgumentList $argList -WorkingDirectory $CoreDir | Out-Null
  Write-Host "Started: $Name -> $logPath"
}

# Başlat
Start-ECIProcess -Name "API" -Cmd "npm run eci:api"
Start-ECIProcess -Name "WORKER" -Cmd "npm run eci:worker"

Write-Host ""
Write-Host "Kontrol:"
Write-Host "  curl.exe -i http://127.0.0.1:$ApiPort/health"
