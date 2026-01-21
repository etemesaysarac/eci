$Base = "http://127.0.0.1:3001"
$Conn = "cmk28anrb0000e6gwaprps4hn"

$proofDir = Join-Path (Get-Location) "proofs"
New-Item -ItemType Directory -Force -Path $proofDir | Out-Null

$ts  = (Get-Date).ToString("yyyyMMdd_HHmmss")
$log = Join-Path $proofDir "commonlabel_quickprobe_$ts.log"

function Log([string]$s) {
  Add-Content -Path $log -Encoding utf8 -Value $s
}

function CurlCapture([string]$url) {
  $h = New-TemporaryFile
  $b = New-TemporaryFile
  $code = & curl.exe -sS -L -D $h -o $b -w "%{http_code}" $url
  return [pscustomobject]@{
    Code    = $code
    Headers = (Get-Content $h -Raw)
    Body    = (Get-Content $b -Raw)
    Url     = $url
  }
}

Log "===== CommonLabel QuickProbe $ts ====="
Log ""

# 0) Health (kanıt)
$health = CurlCapture "$Base/health"
Log "[HEALTH] $($health.Code) $($health.Url)"
Log $health.Body.Trim()
Log ""

# 1) TEX/ARAS aday var mı? (asıl blokajı netleştirir)
$discUrl = "$Base/v1/sprint11/labels/common/ensure?dryRun=1&discoverAlternatives=1&carrier=TEX,ARAS&statuses=Created,Picking,Invoiced,ReadyToShip,Shipped,Delivered&lookbackDays=90&includeNoStatus=1&probeLegacy=0&maxAttempts=2&baseDelayMs=300&maxDelayMs=700"
$disc = CurlCapture $discUrl
Log "[DISCOVER] $($disc.Code) $($disc.Url)"
Log $disc.Body.Trim()
Log ""

# 2) Elindeki tracking’lerle hızlı dene (kanıt için)
$cargos = @(
  "7340029740730347",
  "7340029429233381",
  "7340029306138747",
  "7260029679155780"
)

foreach ($cargo in $cargos) {
  Log "----- cargoTrackingNumber=$cargo -----"

  $ensureUrl = "$Base/v1/sprint11/labels/common/ensure?connectionId=$Conn&dryRun=0&createFirst=1&probeLegacy=0&includeNoStatus=1&discoverAlternatives=0&maxAttempts=2&baseDelayMs=400&maxDelayMs=900&carrier=TEX,ARAS,Marketplace&statuses=Picking,Invoiced,ReadyToShip,Shipped,Delivered&lookbackDays=90&cargoTrackingNumber=$cargo"
  $ens = CurlCapture $ensureUrl
  Log "[ENSURE] $($ens.Code) $($ens.Url)"
  Log $ens.Body.Trim()

  $dlUrl = "$Base/v1/sprint11/labels/common/$cargo/download?dryRun=0&connectionId=$Conn"
  $dl = CurlCapture $dlUrl
  Log "[DOWNLOAD] $($dl.Code) $($dl.Url)"
  Log ("BODY_PREVIEW: " + ($dl.Body.Trim().Substring(0, [Math]::Min(220, $dl.Body.Trim().Length))))
  Log ""

  if ($dl.Code -eq "200") {
    $zplPath = Join-Path $proofDir "commonlabel_$cargo.zpl"
    $dl.Body | Out-File -Encoding ascii $zplPath
    Log "✅ ZPL_SAVED: $zplPath"
    break
  }
}

Write-Host "DONE. Proof log: $log"
