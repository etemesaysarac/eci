param(
  [string]$Base = "http://127.0.0.1:3001",
  [string]$ProofRelPath = "services/core/proofs/SPRINT_11_PROOF.md"
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
  if ($lang -and $lang.Length -gt 0) { Add-Line $path ("~~~" + $lang) } else { Add-Line $path "~~~" }
  Add-Line $path ($content.TrimEnd())
  Add-Line $path "~~~"
  Add-Line $path ""
}

function Invoke-Native([string]$exe, [string[]]$argv) {
  $out = & $exe @argv 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw ("{0} failed (exit={1}): {2}" -f $exe, $LASTEXITCODE, $out.Trim())
  }
  return $out
}

function Invoke-Curl([string[]]$argv) {
  return Invoke-Native "curl.exe" $argv
}

function Get-EnvFirst([string[]]$names, [string]$fallback="") {
  foreach ($n in $names) {
    $v = [string]([Environment]::GetEnvironmentVariable($n))
    if ($v -and $v.Trim().Length -gt 0) { return $v.Trim() }
  }
  return $fallback
}

function Uri-Q([hashtable]$q) {
  $pairs = @()
  foreach ($k in $q.Keys) {
    $v = [string]$q[$k]
    if ($null -ne $v -and $v.Length -gt 0) {
      $pairs += ("{0}={1}" -f [uri]::EscapeDataString($k), [uri]::EscapeDataString($v))
    }
  }
  return ($pairs -join "&")
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$proofPath = Join-Path $repoRoot.Path $ProofRelPath
Ensure-Dir $proofPath

Write-Utf8NoBom $proofPath "# ECI - Sprint 11 Proof Pack (Invoice / Label)`r`n> Generated automatically (PowerShell 5 compatible)`r`n`r`n"

# 0) Health
$healthRaw = Invoke-Curl @("-i","-sS","$Base/health")
Add-CodeBlock $proofPath "## 0) API - GET /health" $healthRaw

# 1) Connections
$connsRaw = Invoke-Curl @("-sS","$Base/v1/connections")
Add-CodeBlock $proofPath "## 1) API - GET /v1/connections" $connsRaw "json"
$conns = $connsRaw | ConvertFrom-Json
if (-not $conns) { throw "No connections returned from API." }

$trConns = $conns | Where-Object { $_.type -eq "trendyol" -or $_.type -eq "TRENDYOL" -or $_.provider -eq "TRENDYOL" }
if (-not $trConns) { $trConns = $conns }

# 2) Sample discovery
$statuses = "Picking,Invoiced,Shipped,Created,AtCollectionPoint,Awaiting,Delivered,Cancelled,UnDelivered,Returned,Repack,UnSupplied"
$lookbackDays = 90

$OVERRIDE_CONN  = Get-EnvFirst @("ECI_S11_CONNECTION_ID") ""
$OVERRIDE_CARGO = Get-EnvFirst @("ECI_S11_CARGO_TRACKING_NUMBER","ECI_S11_CARGO_TRACKING") ""
$OVERRIDE_PKG_RAW = Get-EnvFirst @("ECI_S11_SHIPMENT_PACKAGE_ID") ""
$OVERRIDE_PKG = 0
if ($OVERRIDE_PKG_RAW -match '^\d+$') { $OVERRIDE_PKG = [int64]$OVERRIDE_PKG_RAW }

$q = @{ statuses=$statuses; carrier="TEX,ARAS"; size="10"; page="0"; lookbackDays=[string]$lookbackDays }
if ($OVERRIDE_CONN) { $q.connectionId = $OVERRIDE_CONN }
$sampleUrl = "$Base/v1/sprint11/orders/sample?" + (Uri-Q $q)

$sampleRaw = Invoke-Curl @("-sS", $sampleUrl)
Add-CodeBlock $proofPath "## 2) API - GET /v1/sprint11/orders/sample (multi-connection + multi-status)" $sampleRaw "json"
$sample = $sampleRaw | ConvertFrom-Json

$CONN = $OVERRIDE_CONN
if (-not $CONN) {
  if ($sample.pickedConnection -and $sample.pickedConnection.id) { $CONN = $sample.pickedConnection.id }
  else { $CONN = ($trConns | Select-Object -First 1).id }
}
Add-CodeBlock $proofPath "## 2.1) Chosen connectionId" ("connectionId=" + $CONN)

$cargo = ""
if ($sample.forLabel -and $sample.forLabel.cargoTrackingNumber) { $cargo = [string]$sample.forLabel.cargoTrackingNumber }
if (-not $cargo -and $sample.sample -and $sample.sample.cargoTrackingNumber) { $cargo = [string]$sample.sample.cargoTrackingNumber }
if (-not $cargo -and $OVERRIDE_CARGO) { $cargo = $OVERRIDE_CARGO }

$pkg = 0
if ($sample.forInvoice -and $sample.forInvoice.shipmentPackageId) { $pkg = [int64]$sample.forInvoice.shipmentPackageId }
if (-not $pkg -and $sample.sample -and $sample.sample.shipmentPackageId) { $pkg = [int64]$sample.sample.shipmentPackageId }
if (-not $pkg -and $OVERRIDE_PKG -gt 0) { $pkg = $OVERRIDE_PKG }

$cust = $null
if ($sample.forInvoice -and $sample.forInvoice.customerId) { $cust = $sample.forInvoice.customerId }
if (-not $cust -and $sample.sample -and $sample.sample.customerId) { $cust = $sample.sample.customerId }

if ($OVERRIDE_CARGO -or $OVERRIDE_PKG -gt 0) {
  Add-CodeBlock $proofPath "## 2.3) Manual override IDs (env)" ("cargoTrackingNumber=$OVERRIDE_CARGO`nshipmentPackageId=$OVERRIDE_PKG")
}

# 3) Addresses
$addrRaw = Invoke-Curl @("-sS","$Base/v1/sprint11/seller/addresses?connectionId=$CONN")
Add-CodeBlock $proofPath "## 3) API - GET /v1/sprint11/seller/addresses" $addrRaw "json"

# 4) Common label
if ($cargo) {
  $clGet = Invoke-Curl @("-sS","$Base/v1/sprint11/labels/common/${cargo}?connectionId=${CONN}")
  Add-CodeBlock $proofPath "## 4) API - GET /v1/sprint11/labels/common/:cargoTrackingNumber" $clGet "json"

  $clDl = Invoke-Curl @("-i","-sS","$Base/v1/sprint11/labels/common/${cargo}/download?connectionId=${CONN}")
  Add-CodeBlock $proofPath "## 4.1) API - GET /v1/sprint11/labels/common/:cargoTrackingNumber/download" $clDl

  $clCreateBody = "{`"connectionId`":`"$CONN`",`"cargoTrackingNumber`":`"$cargo`",`"format`":`"ZPL`"}"
  $clCreate = Invoke-Curl @("-sS","-H","Content-Type: application/json","-d",$clCreateBody,"$Base/v1/sprint11/labels/common/create?dryRun=1")
  Add-CodeBlock $proofPath "## 4.2) API - POST /v1/sprint11/labels/common/create (dryRun=1)" $clCreate "json"
} else {
  Add-Line $proofPath "## 4) Common label"
  Add-Line $proofPath "cargoTrackingNumber bulunamadi (sample order'da yok). Proof, label adimlarini atladi."
  Add-Line $proofPath ""
}

# 5) Invoice link (dryRun)
if ($pkg -gt 0) {
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $invNo = ("ECI-" + $pkg)

  $pdfB64 = "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NCA+PgpzdHJlYW0KQlQKL0YxIDEyIFRmCjcyIDEwMCBUZAooRUNJIFNwcmludCAxMSBJbnZvaWNlIFByb29mKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxMCAwMDAwMCBuIAowMDAwMDAwMDY2IDAwMDAwIG4gCjAwMDAwMDAxMzYgMDAwMDAgbiAKMDAwMDAwMDI0MyAwMDAwMCBuIAp0cmFpbGVyCjw8IC9Sb290IDEgMCBSIC9TaXplIDUgPj4Kc3RhcnR4cmVmCjQwMAolJUVPRg=="
  $pdfPath = Join-Path $repoRoot.Path ("outputs\sprint11\proof_invoice_{0}.pdf" -f $pkg)
  Ensure-Dir $pdfPath
  [IO.File]::WriteAllBytes($pdfPath, [Convert]::FromBase64String($pdfB64))

  $PUBLIC_BASE = Get-EnvFirst @("ECI_S11_PUBLIC_BASE_URL","ECI_PUBLIC_BASE_URL") ""
  $invLink = $null

  if ($PUBLIC_BASE) {
    $pubUrl = "$Base/v1/sprint11/invoices/file/publish?" + (Uri-Q @{ connectionId=$CONN; shipmentPackageId=[string]$pkg; invoiceDateTime=[string]$nowMs; invoiceNumber=$invNo; dryRun="0" })
    $pubRaw = Invoke-Curl @(
      "-sS",
      "-X","POST",
      "-H","Content-Type: application/pdf",
      "--data-binary","@$pdfPath",
      $pubUrl
    )
    Add-CodeBlock $proofPath "## 5.A0) API - POST /v1/sprint11/invoices/file/publish (dryRun=0)" $pubRaw "json"
    try {
      $pub = $pubRaw | ConvertFrom-Json
      if ($pub -and $pub.invoiceLink) { $invLink = [string]$pub.invoiceLink }
    } catch { $invLink = $null }
  } else {
    Add-Line $proofPath "## 5.A0) Invoice publish"
    Add-Line $proofPath "ECI_PUBLIC_BASE_URL bulunamadi. Publish adimi atladi; invoiceLink placeholder kalir (kapanis icin PUBLIC_BASE_URL gerekli)."
    Add-Line $proofPath ""
  }

  if (-not $invLink) { $invLink = ("https://example.com/invoices/" + $pkg + ".pdf") }

  $invFileRaw = Invoke-Curl @(
    "-sS",
    "-X","POST",
    "-H","Content-Type: application/pdf",
    "--data-binary","@$pdfPath",
    ("$Base/v1/sprint11/invoices/file/raw?" + (Uri-Q @{ connectionId=$CONN; shipmentPackageId=[string]$pkg; invoiceDateTime=[string]$nowMs; invoiceNumber=$invNo; dryRun="1" }))
  )
  Add-CodeBlock $proofPath "## 5.A) API - POST /v1/sprint11/invoices/file/raw (dryRun=1)" $invFileRaw "json"

  $invBody = "{`"connectionId`":`"$CONN`",`"invoiceLink`":`"$invLink`",`"shipmentPackageId`":$pkg,`"invoiceDateTime`":$nowMs,`"invoiceNumber`":`"$invNo`"}"
  $invSend = Invoke-Curl @("-sS","-H","Content-Type: application/json","-d",$invBody,"$Base/v1/sprint11/invoices/link?dryRun=1")
  Add-CodeBlock $proofPath "## 5) API - POST /v1/sprint11/invoices/link (dryRun=1)" $invSend "json"

  if ($cust) {
    $delBody = "{`"connectionId`":`"$CONN`",`"serviceSourceId`":$pkg,`"channelId`":1,`"customerId`":$cust}"
    $invDel = Invoke-Curl @("-sS","-H","Content-Type: application/json","-d",$delBody,"$Base/v1/sprint11/invoices/link/delete?dryRun=1")
    Add-CodeBlock $proofPath "## 5.1) API - POST /v1/sprint11/invoices/link/delete (dryRun=1)" $invDel "json"
  } else {
    Add-Line $proofPath "## 5.1) Invoice link delete"
    Add-Line $proofPath "customerId bulunamadi. Delete adimi atladi."
    Add-Line $proofPath ""
  }
} else {
  Add-Line $proofPath "## 5) Invoice link"
  Add-Line $proofPath "shipmentPackageId bulunamadi. Proof, invoice link adimlarini atladi."
  Add-Line $proofPath ""
}

Add-Line $proofPath "---"
Add-Line $proofPath ("Generated: " + (Get-Date -Format o))

Write-Host ("SPRINT_11_PROOF generated: {0}" -f $proofPath)
