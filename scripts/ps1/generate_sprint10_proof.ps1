param(
  [string]$Base = "http://127.0.0.1:3001",
  [string]$ProofRelPath = "services/core/proofs/SPRINT_10_PROOF.md",
  [string]$WorkerLogPath = "$env:TEMP\eci_worker.log"
)

$ErrorActionPreference = "Stop"

function Ensure-Dir([string]$p) {
  $dir = Split-Path -Parent $p
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

function Write-Utf8NoBom([string]$path, [string]$text) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
}

function Add-Line([string]$path, [string]$line) {
  Add-Content -Encoding UTF8 -Path $path -Value $line
}

function Add-CodeBlock([string]$path, [string]$title, [string]$content, [string]$lang="") {
  Add-Line $path $title
  if ($lang.Length -gt 0) { Add-Line $path ("~~~" + $lang) } else { Add-Line $path "~~~" }
  Add-Line $path ($content.TrimEnd())
  Add-Line $path "~~~"
  Add-Line $path ""
}

$proofPath = Join-Path (Get-Location).Path $ProofRelPath
Ensure-Dir $proofPath

# 0) Header
Write-Utf8NoBom $proofPath "# ECI — Sprint 10 Proof Pack`r`n> Generated automatically (PowerShell-safe)`r`n`r`n"

# 1) Infra + health
Add-CodeBlock $proofPath "## 0) Infra — docker ps" ((docker ps) -join "`n")
$healthRaw = (curl.exe -sS "$Base/health" | Out-String)
Add-CodeBlock $proofPath "## 1) API — GET /health" $healthRaw "json"

# 2) Connections (pick Trendyol-ish or first)
$connsRaw = (curl.exe -sS "$Base/v1/connections" | Out-String)
Add-CodeBlock $proofPath "## 2) API — GET /v1/connections" $connsRaw "json"

$conns = $connsRaw | ConvertFrom-Json
if (-not $conns) { throw "No connections returned from API." }

$picked = $conns | Where-Object { $_.provider -eq "TRENDYOL" -or $_.type -eq "TRENDYOL" } | Select-Object -First 1
if (-not $picked) { $picked = $conns | Select-Object -First 1 }
$CONN = $picked.id
Add-CodeBlock $proofPath "## 2.1) Picked connectionId" ("connectionId=" + $CONN)

# 3) Connection status
$statusRaw = (curl.exe -sS "$Base/v1/connections/$CONN/status" | Out-String)
Add-CodeBlock $proofPath "## 3) API — GET /v1/connections/:id/status" $statusRaw "json"

# 4) Pick one variant from DB (most reliable)
$sqlVar = 'select "barcode", coalesce("stock",0), coalesce("salePrice",199.99), coalesce("listPrice",249.99) from "ProductVariant" where "barcode" is not null and length("barcode")>0 order by "updatedAt" desc limit 1;'
$row = (docker exec -i infra-postgres-1 psql -U eci -d eci -t -A -F "|" -c "$sqlVar").Trim()
if (-not $row) { throw "No ProductVariant with barcode found in DB." }

Add-CodeBlock $proofPath "## 4) DB — Picked ProductVariant row" $row

$parts = $row.Split("|")
$BARCODE = $parts[0].Trim()
$STOCK   = [int]$parts[1].Trim()
$SALE    = [decimal]$parts[2].Trim()
$LIST    = [decimal]$parts[3].Trim()

# Dedup'a takılmamak için quantity'yi 1 artır (clamp 20000)
$Q = [Math]::Min(20000, $STOCK + 1)
if ($Q -lt 1) { $Q = 1 }

# 5) Build payload -> temp JSON file (UTF8 no BOM)
$payloadObj = @{
  connectionId = $CONN
  items = @(
    @{
      barcode      = $BARCODE
      quantity     = $Q
      salePrice    = $SALE
      listPrice    = $LIST
      currencyType = "TRY"
    }
  )
}
$payloadJson = ($payloadObj | ConvertTo-Json -Depth 10)
$payloadPath = Join-Path $env:TEMP "eci_inventory_push.json"
Write-Utf8NoBom $payloadPath $payloadJson

Add-CodeBlock $proofPath "## 5) Payload (file)" ("path=" + $payloadPath + "`n" + $payloadJson) "json"

# 6) Push #1
$push1 = (curl.exe -sS -X POST "$Base/v1/inventory/push" -H "Content-Type: application/json" --data-binary "@$payloadPath" | Out-String)
Add-CodeBlock $proofPath "## 6) Push #1 — POST /v1/inventory/push" $push1 "json"

$push1Obj = $push1 | ConvertFrom-Json
$JOB = $push1Obj.jobId
if (-not $JOB) { throw "Push #1 did not return jobId." }
Add-CodeBlock $proofPath "## 6.1) jobId" $JOB

# 7) Job summary from DB -> batchRequestId
$sqlJob = "select summary::text from ""Job"" where id='$JOB';"
$jobSummary = (docker exec -i infra-postgres-1 psql -U eci -d eci -t -A -c "$sqlJob").Trim()
Add-CodeBlock $proofPath "## 7) DB — Job.summary" $jobSummary

$m = [regex]::Match($jobSummary, '"batchRequestId"\s*:\s*"([^"]+)"')
if (-not $m.Success) { throw "batchRequestId not found in Job.summary." }
$BATCH = $m.Groups[1].Value
Add-CodeBlock $proofPath "## 7.1) batchRequestId" $BATCH

# 8) Poll loop (up to 90s)
$deadline = (Get-Date).AddSeconds(90)
$attempt = 0
$poll = ""

while ((Get-Date) -lt $deadline) {
  $attempt++
  $poll = (curl.exe -sS -G "$Base/v1/inventory/batch/$BATCH" --data-urlencode "connectionId=$CONN" | Out-String)
  try {
    $pj = $poll | ConvertFrom-Json
    if ($pj.items -and @($pj.items).Count -gt 0) { break }
  } catch { }
  Start-Sleep -Seconds 5
}
Add-CodeBlock $proofPath "## 8) Poll — GET /v1/inventory/batch/:batchId (attempts=$attempt)" $poll "json"

# 9) Dedup proof: same-body Push #2
$push2 = (curl.exe -sS -X POST "$Base/v1/inventory/push" -H "Content-Type: application/json" --data-binary "@$payloadPath" | Out-String)
Add-CodeBlock $proofPath "## 9) Push #2 (same-body) — dedup proof" $push2 "json"

# 10) Worker log excerpt (if available)
if (Test-Path $WorkerLogPath) {
  $ex = (Select-String -Path $WorkerLogPath -Pattern $JOB -Context 8,8 | Out-String)
  if ([string]::IsNullOrWhiteSpace($ex)) { $ex = "No lines found for jobId=$JOB in $WorkerLogPath" }
  Add-CodeBlock $proofPath "## 10) Worker excerpt (jobId context)" $ex
} else {
  Add-CodeBlock $proofPath "## 10) Worker excerpt" ("Worker log not found at: " + $WorkerLogPath)
}

Add-Line $proofPath "## Done"
Add-Line $proofPath ("- proof: " + $proofPath)
Add-Line $proofPath ("- connectionId: " + $CONN)
Add-Line $proofPath ("- jobId: " + $JOB)
Add-Line $proofPath ("- batchRequestId: " + $BATCH)
Add-Line $proofPath ""

Write-Host ("OK: " + $proofPath)
