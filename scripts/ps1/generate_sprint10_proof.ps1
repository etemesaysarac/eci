param(
  [string]$Base = "http://127.0.0.1:3001",
  [string]$ProofRelPath = "services/core/proofs/SPRINT_10_PROOF.md",
  [string]$WorkerLogPath = ""
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

function Invoke-Native([string]$exe, [string[]]$argv) {
  # NOTE: Do NOT use a parameter named $args in PowerShell; it's an automatic variable.
  $out = & $exe @argv 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw ("{0} failed (exit={1}): {2}" -f $exe, $LASTEXITCODE, $out.Trim())
  }
  return $out
}

function Invoke-Curl([string[]]$argv) {
  return Invoke-Native "curl.exe" $argv
}

function Invoke-Docker([string[]]$argv) {
  return Invoke-Native "docker.exe" $argv
}

function Http-Body([string]$raw) {
  $idx = $raw.LastIndexOf("`r`n`r`n")
  if ($idx -ge 0) { return $raw.Substring($idx + 4) }
  $idx = $raw.LastIndexOf("`n`n")
  if ($idx -ge 0) { return $raw.Substring($idx + 2) }
  return $raw
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
# Worker log path autodetect (Sprint 10 proof needs a snippet, but we don't assume your local paths)
# Priority: repoRoot\worker.log -> services\core\worker.log -> outputs\worker.log -> %TEMP%\eci_worker.log
if ([string]::IsNullOrWhiteSpace($WorkerLogPath)) {
  $candidates = @(
    (Join-Path $repoRoot.Path "worker.log"),
    (Join-Path $repoRoot.Path "services\core\worker.log"),
    (Join-Path $repoRoot.Path "outputs\worker.log"),
    (Join-Path $env:TEMP "eci_worker.log"),
    (Join-Path $env:TEMP "worker.log")
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $WorkerLogPath = $c; break }
  }
}
$proofPath = Join-Path $repoRoot.Path $ProofRelPath
Ensure-Dir $proofPath

Write-Utf8NoBom $proofPath "# ECI — Sprint 10 Proof Pack`r`n> Generated automatically (PowerShell-safe)`r`n`r`n"

# 0) Infra
$dockerPs = Invoke-Docker @("ps")
Add-CodeBlock $proofPath "## 0) Infra — docker ps" $dockerPs

# 1) Health (fail fast if API not reachable)
$healthRaw = Invoke-Curl @("-i","-sS","$Base/health")
$healthBody = (Http-Body $healthRaw).Trim()
Add-CodeBlock $proofPath "## 1) API — GET /health" $healthRaw
if ([string]::IsNullOrWhiteSpace($healthBody)) { throw "API health response is empty (is API running?)" }

# 2) Connections (evidence + parse)
$connsRaw = Invoke-Curl @("-sS","$Base/v1/connections")
Add-CodeBlock $proofPath "## 2) API — GET /v1/connections" $connsRaw "json"
$conns = $connsRaw | ConvertFrom-Json
if (-not $conns) { throw "No connections returned from API." }

$picked = $conns | Where-Object { $_.provider -eq "TRENDYOL" -or $_.type -eq "TRENDYOL" -or $_.type -eq "trendyol" } | Select-Object -First 1
if (-not $picked) { $picked = $conns | Select-Object -First 1 }
$CONN = $picked.id
Add-CodeBlock $proofPath "## 2.1) Picked connectionId" ("connectionId=" + $CONN)

# 3) Connection status
$statusRaw = Invoke-Curl @("-sS","$Base/v1/connections/$CONN/status")
Add-CodeBlock $proofPath "## 3) API — GET /v1/connections/:id/status" $statusRaw "json"

# 3.1) Ensure Sprint 10 DB table exists (safe, idempotent)
$ensureSql = @'
CREATE TABLE IF NOT EXISTS "inventory_confirmed_state" (
  "connectionId" TEXT NOT NULL,
  "barcode" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "salePrice" DECIMAL(18,4) NOT NULL,
  "listPrice" DECIMAL(18,4) NOT NULL,
  "currencyType" TEXT,
  "lastBatchRequestId" TEXT,
  "lastConfirmedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_confirmed_state_pkey" PRIMARY KEY ("connectionId", "barcode"),
  CONSTRAINT "inventory_confirmed_state_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "inventory_confirmed_state_connectionId_idx" ON "inventory_confirmed_state"("connectionId");
CREATE INDEX IF NOT EXISTS "inventory_confirmed_state_barcode_idx" ON "inventory_confirmed_state"("barcode");
'@

$ensureOut = Invoke-Docker @("exec","-i","infra-postgres-1","psql","-U","eci","-d","eci","-c",$ensureSql)
Add-CodeBlock $proofPath "## 3.1) DB — Ensure inventory_confirmed_state" $ensureOut

# 4) Pick one barcode from DB (prefer confirmed state, fallback to ProductVariant, then known-good)
$row = ""

try {
  $sqlConfirmedPick = ('select "barcode", "quantity", "salePrice", "listPrice" from "inventory_confirmed_state" where "connectionId"=''{0}'' order by "lastConfirmedAt" desc limit 1;' -f $CONN)
  $row = (Invoke-Docker @("exec","-i","infra-postgres-1","psql","-U","eci","-d","eci","-t","-A","-F","|","-c",$sqlConfirmedPick)).Trim()
  if ($row) {
    Add-CodeBlock $proofPath "## 4) DB — Picked inventory_confirmed_state row" $row
  }
} catch { }

if (-not $row) {
  $sqlVar = 'select "barcode", coalesce("stock",0), coalesce("salePrice",199.99), coalesce("listPrice",249.99) from "ProductVariant" where "barcode" is not null and length("barcode")>0 order by "updatedAt" desc limit 1;'
  $row = (Invoke-Docker @("exec","-i","infra-postgres-1","psql","-U","eci","-d","eci","-t","-A","-F","|","-c",$sqlVar)).Trim()
}

if (-not $row) {
  $BARCODE = "8608802530385"
  $STOCK   = 3
  $SALE    = 191.93
  $LIST    = 331.96
  Add-CodeBlock $proofPath "## 4) DB — Picked row (fallback)" ("{0}|{1}|{2}|{3}" -f $BARCODE,$STOCK,$SALE,$LIST)
} else {
  # if row came from ProductVariant, we didn't already log it
  if ($row -and ($row -match "\\|") -and ($row -notmatch "inventory_confirmed_state")) {
    Add-CodeBlock $proofPath "## 4) DB — Picked ProductVariant row" $row
  }
  $parts = $row.Split("|")
  $BARCODE = $parts[0].Trim()
  $STOCK   = [int]$parts[1].Trim()
  $SALE    = [decimal]$parts[2].Trim()
  $LIST    = [decimal]$parts[3].Trim()
}

# Keep same quantity to avoid changing live inventory; clamp only the Trendyol hard limit.
$Q = [Math]::Min(20000, [Math]::Max(0, $STOCK))

# 5) Payload -> temp JSON file (UTF8 no BOM)
$payloadObj = @{ connectionId = $CONN; items = @( @{ barcode=$BARCODE; quantity=$Q; salePrice=$SALE; listPrice=$LIST; currencyType="TRY" } ) }
$payloadJson = ($payloadObj | ConvertTo-Json -Depth 10)
$payloadPath = Join-Path $env:TEMP "eci_inventory_push.json"
Write-Utf8NoBom $payloadPath $payloadJson
Add-CodeBlock $proofPath "## 5) Payload (file)" ("path=" + $payloadPath + "`n" + $payloadJson) "json"

# 6) Push #1
# - force=1 bypasses diff-noop (proof wants a batchRequestId even if values are unchanged)
# - forceWrite=1 allows a single remote send in local/dev without restarting worker
$push1Raw = Invoke-Curl @("-i","-sS","-X","POST","$Base/v1/inventory/push?force=1&forceWrite=1","-H","Content-Type: application/json","--data-binary","@$payloadPath")
Add-CodeBlock $proofPath "## 6) Push #1 — POST /v1/inventory/push" $push1Raw
$push1Obj = (Http-Body $push1Raw) | ConvertFrom-Json
$JOB = $push1Obj.jobId
if (-not $JOB) { throw "Push #1 did not return jobId." }
$BODY_HASH = $push1Obj.bodyHash
Add-CodeBlock $proofPath "## 6.1) jobId" $JOB
if ($BODY_HASH) { Add-CodeBlock $proofPath "## 6.2) bodyHash" $BODY_HASH }

# 7) Wait job completion + read summary from DB
$BATCH = ""
$jobStatus = ""
$jobSummary = ""

$deadline = (Get-Date).AddSeconds(120)
$attempt = 0
while ((Get-Date) -lt $deadline) {
  $attempt++
  $sqlJob = ('select status, coalesce(summary::text,'''') from "Job" where id=''{0}'';' -f $JOB)
  $jobRow = (Invoke-Docker @("exec","-i","infra-postgres-1","psql","-U","eci","-d","eci","-t","-A","-F","|","-c",$sqlJob)).Trim()
  if ($jobRow) {
    $cols = $jobRow.Split("|", 2)
    $jobStatus = $cols[0].Trim()
    $jobSummary = if ($cols.Count -gt 1) { $cols[1] } else { "" }
    if ($jobStatus -eq "success" -or $jobStatus -eq "failed") { break }
  }
  Start-Sleep -Seconds 2
}

Add-CodeBlock $proofPath "## 7) DB — Job status+summary (polled)" ("attempts={0}`nstatus={1}`nsummary={2}" -f $attempt,$jobStatus,$jobSummary)

if ($jobSummary) {
  $m = [regex]::Match($jobSummary, '"batchRequestId"\s*:\s*"([^"]+)"')
  if ($m.Success) { $BATCH = $m.Groups[1].Value }
}

if ($BATCH) { Add-CodeBlock $proofPath "## 7.1) batchRequestId" $BATCH } else { Add-CodeBlock $proofPath "## 7.1) batchRequestId" "MISSING (check worker/Trendyol or dry-run)" }

# 8) Poll loop (up to 90s) - only if we have batchRequestId
$poll = ""
if ($BATCH) {
  $deadline = (Get-Date).AddSeconds(90)
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    $attempt++
    $poll = Invoke-Curl @("-i","-sS","-G","$Base/v1/inventory/batch/$BATCH","--data-urlencode","connectionId=$CONN")
    try {
      $pj = (Http-Body $poll) | ConvertFrom-Json
      $items = @($pj.items)
      if ($items -and $items.Count -gt 0) {
        $statuses = @($items | ForEach-Object { ("" + $_.status).ToUpperInvariant() })
        $hasSuccess = $statuses -contains "SUCCESS"
        # Trendyol bazı hesaplarda farklı ara durumlar döndürebiliyor; güvenli tarafta kalıyoruz.
        $hasProcessing = ($statuses -contains "PROCESSING") -or ($statuses -contains "IN_PROGRESS") -or ($statuses -contains "PENDING") -or ($statuses -contains "WAITING")
        if ($hasSuccess) { break }
        if (-not $hasProcessing) { break } # terminal ama SUCCESS yok
      }
    } catch { }
    Start-Sleep -Seconds 5
  }
  Add-CodeBlock $proofPath "## 8) Poll — GET /v1/inventory/batch/:batchId (attempts=$attempt)" $poll

  # 8.0) Poll status summary
  try {
    $pj2 = (Http-Body $poll) | ConvertFrom-Json
    $it2 = @($pj2.items)
    if ($it2 -and $it2.Count -gt 0) {
      $sum = (@($it2 | Group-Object status | ForEach-Object { ("" + $_.Name) + ":" + $_.Count }) -join ", ")
      Add-CodeBlock $proofPath "## 8.0) Poll — status summary" ($sum ? $sum : "(no items)")
    }
  } catch { }


  # 8.1) DB confirmed row (after poll SUCCESS)
  $sqlConf = ('select "barcode","quantity","salePrice","listPrice","currencyType","lastBatchRequestId","lastConfirmedAt" from "inventory_confirmed_state" where "connectionId"=''{0}'' and "barcode"=''{1}'';' -f $CONN,$BARCODE)
  $confRow = (Invoke-Docker @("exec","-i","infra-postgres-1","psql","-U","eci","-d","eci","-t","-A","-F","|","-c",$sqlConf)).Trim()
  Add-CodeBlock $proofPath "## 8.1) DB — inventory_confirmed_state row" ($confRow ? $confRow : "(no row found yet)")
} else {
  Add-CodeBlock $proofPath "## 8) Poll — GET /v1/inventory/batch/:batchId" "SKIPPED (no batchRequestId)"
}

# 9) Dedup proof: same-body Push #2
$push2Raw = Invoke-Curl @("-i","-sS","-X","POST","$Base/v1/inventory/push?force=1&forceWrite=1","-H","Content-Type: application/json","--data-binary","@$payloadPath")
Add-CodeBlock $proofPath "## 9) Push #2 (same-body) — dedup proof" $push2Raw

# 9.1) Redis dedup key proof (best effort)
if ($BODY_HASH) {
  $redisName = (Invoke-Docker @("ps","--filter","name=redis","--format","{{.Names}}") | Out-String).Trim().Split("`n") | Select-Object -First 1
  $dedupKey = ("eci:inv:dedup:{0}:{1}" -f $CONN, $BODY_HASH)
  if ($redisName) {
    $rGet = (Invoke-Docker @("exec","-i",$redisName,"redis-cli","GET",$dedupKey)).Trim()
    $rTtl = (Invoke-Docker @("exec","-i",$redisName,"redis-cli","TTL",$dedupKey)).Trim()
    Add-CodeBlock $proofPath "## 9.1) Redis — dedup key" ("redis={0}`nkey={1}`nGET={2}`nTTL={3}" -f $redisName,$dedupKey,$rGet,$rTtl)
  } else {
    Add-CodeBlock $proofPath "## 9.1) Redis — dedup key" ("redis container not found; key={0}" -f $dedupKey)
  }
} else {
  Add-CodeBlock $proofPath "## 9.1) Redis — dedup key" "SKIPPED (bodyHash missing from push response)"
}

# 10) Chunking proof (1001 items -> 2 jobs) using dryRun=1
$chunkItems = @()
for ($i=1; $i -le 1001; $i++) {
  $chunkItems += @{ barcode = ("DRY-{0:D6}" -f $i); quantity = 1; salePrice = 1.00; listPrice = 2.00; currencyType = "TRY" }
}
$chunkPayloadObj = @{ connectionId = $CONN; items = $chunkItems }
$chunkPayloadJson = ($chunkPayloadObj | ConvertTo-Json -Depth 10)
$chunkPayloadPath = Join-Path $env:TEMP "eci_inventory_chunk_1001.json"
Write-Utf8NoBom $chunkPayloadPath $chunkPayloadJson
Add-CodeBlock $proofPath "## 10) Chunking payload (1001 items, dry-run)" ("path=" + $chunkPayloadPath + "`nitems=1001")

$chunkPushRaw = Invoke-Curl @("-i","-sS","-X","POST","$Base/v1/inventory/push?dryRun=1","-H","Content-Type: application/json","--data-binary","@$chunkPayloadPath")
Add-CodeBlock $proofPath "## 10.1) Chunking — POST /v1/inventory/push?dryRun=1" $chunkPushRaw

try {
  $chunkObj = (Http-Body $chunkPushRaw) | ConvertFrom-Json
  $chunkJobs = @($chunkObj.jobs)
  if ($chunkJobs.Count -gt 0) {
    foreach ($j in $chunkJobs) {
      $jid = $j.jobId
      if (-not $jid) { continue }

      $deadline = (Get-Date).AddSeconds(60)
      $attempt = 0
      $jobStatus2 = ""
      $jobSummary2 = ""
      while ((Get-Date) -lt $deadline) {
        $attempt++
        $sqlJ = ('select status, coalesce(summary::text,'''') from "Job" where id=''{0}'';' -f $jid)
        $rowJ = (Invoke-Docker @("exec","-i","infra-postgres-1","psql","-U","eci","-d","eci","-t","-A","-F","|","-c",$sqlJ)).Trim()
        if ($rowJ) {
          $cols = $rowJ.Split("|", 2)
          $jobStatus2 = $cols[0].Trim()
          $jobSummary2 = if ($cols.Count -gt 1) { $cols[1] } else { "" }
          if ($jobStatus2 -eq "success" -or $jobStatus2 -eq "failed") { break }
        }
        Start-Sleep -Seconds 2
      }
      Add-CodeBlock $proofPath ("## 10.2) DB — Chunk job status+summary (jobId={0}, attempts={1})" -f $jid,$attempt) ("status={0}`nsummary={1}" -f $jobStatus2,$jobSummary2)
    }
  }
} catch {
  Add-CodeBlock $proofPath "## 10.2) Chunk job DB proof" ("SKIPPED (could not parse chunking response): " + $_.Exception.Message)
}

# 11) Worker log excerpt (optional)
if (Test-Path $WorkerLogPath) {
  $ex = (Select-String -Path $WorkerLogPath -Pattern $JOB -Context 8,8 | Out-String)
  if ([string]::IsNullOrWhiteSpace($ex)) { $ex = "No lines found for jobId=$JOB in $WorkerLogPath" }
  Add-CodeBlock $proofPath "## 11) Worker excerpt (jobId context)" $ex
} else {
  Add-CodeBlock $proofPath "## 11) Worker excerpt" ("Worker log not found at: " + $WorkerLogPath)
}

Add-Line $proofPath "## Done"
Add-Line $proofPath ("- proof: " + $proofPath)
Add-Line $proofPath ("- connectionId: " + $CONN)
Add-Line $proofPath ("- jobId: " + $JOB)
Add-Line $proofPath ("- batchRequestId: " + $BATCH)
Add-Line $proofPath ""

Write-Host ("OK: " + $proofPath)
Write-Output ("OK: " + $proofPath)
