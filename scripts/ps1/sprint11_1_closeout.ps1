# PowerShell 5.1 compatible closeout script for Sprint 11.1
# - Uses curl.exe explicitly (avoids PowerShell 'curl' alias)
# - Writes proper newlines (no literal \\r\\n)
# - Continues on errors and records them into the proof file

# Keep this script ultra-robust: it should generate a proof file even if
# some endpoints fail (we want evidence, not a crash).
Set-StrictMode -Off
$ErrorActionPreference = 'Continue'

function Get-PropValue($obj, [string]$Name) {
  try {
    if ($null -eq $obj) { return $null }
    $p = $obj.PSObject.Properties[$Name]
    if ($null -ne $p) { return $p.Value }
    return $null
  } catch {
    return $null
  }
}

function Get-RepoRoot {
  # $PSScriptRoot = <repoRoot>\scripts\ps1
  return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Read-DotEnvValue([string]$EnvPath, [string]$Key) {
  if (-not (Test-Path $EnvPath)) { return $null }
  $lines = Get-Content -LiteralPath $EnvPath -ErrorAction SilentlyContinue
  foreach ($ln in $lines) {
    $t = $ln.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    # key=value
    $idx = $t.IndexOf('=')
    if ($idx -lt 1) { continue }
    $k = $t.Substring(0, $idx).Trim()
    if ($k -ne $Key) { continue }
    $v = $t.Substring($idx + 1).Trim()
    # strip quotes
    if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    return $v
  }
  return $null
}

function Invoke-Curl([string[]]$CurlArgs) {
  $exe = 'curl.exe'
  try {
    # NOTE: Avoid using a parameter named "Args" because PowerShell has an automatic $args variable
    # which can cause confusing binding/splatting behavior on some environments.
    $out = & $exe @CurlArgs 2>&1
    $exit = $LASTEXITCODE
    $txt = ($out -join "`n")
    if ($exit -ne 0) {
      $txt = ($txt + "`n" + "[curl.exe exitCode] " + $exit)
    }
    return $txt
  } catch {
    return "[curl.exe ERROR] $($_.Exception.Message)"
  }
}

function Json-TryParse([string]$Text) {
  try { return ($Text | ConvertFrom-Json -ErrorAction Stop) } catch { return $null }
}

$RepoRoot = Get-RepoRoot
$ProofDir = Join-Path $RepoRoot 'proofs'
if (-not (Test-Path $ProofDir)) { New-Item -ItemType Directory -Path $ProofDir | Out-Null }
$ProofPath = Join-Path $ProofDir 'SPRINT_11_1_CLOSEOUT.md'

$CoreProofDir = Join-Path $RepoRoot 'services\core\proofs'
if (-not (Test-Path $CoreProofDir)) { New-Item -ItemType Directory -Path $CoreProofDir | Out-Null }
$CoreProofPath = Join-Path $CoreProofDir 'SPRINT_11_1_CLOSEOUT.md'

$LocalBase = 'http://127.0.0.1:3001'
$DotEnv = Join-Path $RepoRoot 'services\core\.env'
$PublicBase = $env:ECI_PUBLIC_BASE_URL
if (-not $PublicBase) { $PublicBase = Read-DotEnvValue $DotEnv 'ECI_PUBLIC_BASE_URL' }
if ($PublicBase) { $PublicBase = $PublicBase.Trim().TrimEnd('/') }

# Minimal PDF (base64) to use for invoice submit
$PdfB64 = @'
JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgaHR0cDovL3d3dy5yZXBvcnRsYWIuY29tCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDQgMCBSIC9NZWRpYUJveCBbIDAgMCA2MTIgNzkyIF0gL1BhcmVudCA2IDAgUiAvUmVzb3VyY2VzIDw8Ci9Gb250IDEgMCBSID4+IC9Sb3RhdGUgMCAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovTGVuZ3RoIDExNQo+PgpzdHJlYW0KQlQKL0YxIDEyIFRmCjcyIDcyMCBUZAooRUNJIFNwcmludCAxMS4xIEludm9pY2UgVGVzdCkgVGoKClRkCjcyIDcwMCBUZAooR2VuZXJhdGVkIGZvciBUcmVuZHlvbCBpbnZvaWNlIHN1Ym1pdCBlbmRwb2ludC4pIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PAovVHlwZSAvWE9iamVjdCAvU3VidHlwZSAvSW1hZ2UgL1dpZHRoIDAgL0hlaWdodCAwIC9Db2xvclNwYWNlIC9EZXZpY2VSR0IgL0JpdHNQZXJDb21wb25lbnQgOCAvTGVuZ3RoIDAKPj4KZW5kb2JqCjYgMCBvYmoKPDwKL0NvdW50IDEgL0tpZHMgWyAzIDAgUiBdIC9UeXBlIC9QYWdlcwo+PgplbmRvYmoKNyAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iagp4cmVmCjAgOAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwOTkgMDAwMDAgbiAKMDAwMDAwMDE1MCAwMDAwMCBuIAowMDAwMDAwMjQwIDAwMDAwIG4gCjAwMDAwMDA0MDQgMDAwMDAgbiAKMDAwMDAwMDU5MCAwMDAwMCBuIAowMDAwMDAwNzE5IDAwMDAwIG4gCjAwMDAwMDA4MDkgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA4IC9Sb290IDcgMCBSCj4+CnN0YXJ0eHJlZgo4OTYKJSVFT0YK
'@

$PdfBytes = [Convert]::FromBase64String(($PdfB64 -replace "\s+", ""))
$TmpPdf = Join-Path $env:TEMP "eci_sprint11_1_invoice_test.pdf"
[IO.File]::WriteAllBytes($TmpPdf, $PdfBytes)

$sb = New-Object System.Text.StringBuilder
$null = $sb.AppendLine('# ECI - Sprint 11.1 Closeout Proof')
$null = $sb.AppendLine('> Generated automatically (PowerShell 5.1 compatible)')
$null = $sb.AppendLine(('> ' + (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')))
$null = $sb.AppendLine('')

function Add-Section([string]$Title, [string]$Body) {
  $script:sb.AppendLine('## ' + $Title) | Out-Null
  $script:sb.AppendLine('~~~') | Out-Null
  $script:sb.AppendLine($Body) | Out-Null
  $script:sb.AppendLine('~~~') | Out-Null
  $script:sb.AppendLine('') | Out-Null
  $txt = $script:sb.ToString()
  $enc = (New-Object System.Text.UTF8Encoding($false))
  [IO.File]::WriteAllText($script:ProofPath, $txt, $enc)
  if (Get-Variable -Name CoreProofPath -Scope Script -ErrorAction SilentlyContinue) {
    [IO.File]::WriteAllText($script:CoreProofPath, $txt, $enc)
  }
}

# 0) Infra
try {
  $redisOk = (Test-NetConnection 127.0.0.1 -Port 6379 -WarningAction SilentlyContinue).TcpTestSucceeded
  Add-Section '0) Infra' ("redis: " + ($(if($redisOk){'OK'} else {'FAIL'}) ) + ' (127.0.0.1:6379 reachable)')
} catch {
  Add-Section '0) Infra' ("redis: ERROR " + $_.Exception.Message)
}

# 1) Health checks
try {
  $h1 = Invoke-Curl @('-i','-sS', ($LocalBase + '/health'))
  Add-Section '1) Health (local)' $h1
} catch {
  Add-Section '1) Health (local)' ("ERROR " + $_.Exception.Message)
}

if ($PublicBase) {
  try {
    $h2 = Invoke-Curl @('-i','-sS', ($PublicBase + '/health'))
    Add-Section '2) Health (public)' ("ECI_PUBLIC_BASE_URL=" + $PublicBase + "`n" + $h2)
  } catch {
    Add-Section '2) Health (public)' ("ECI_PUBLIC_BASE_URL=" + $PublicBase + "`nERROR " + $_.Exception.Message)
  }
} else {
  Add-Section '2) Health (public)' 'SKIP (ECI_PUBLIC_BASE_URL not set)'
}

# 3) Find candidate package
# NOTE: Use query param name "carrier" (not "carriers") to match the API handler.
# Include Created so we can promote Created -> Picking -> Invoiced.
$sampleUrl = $LocalBase + '/v1/sprint11/orders/sample?carrier=TEX,ARAS&statuses=Created,Picking,Invoiced,ReadyToShip&lookbackDays=90&size=10&page=0'
$sampleRaw = ''
try {
  $sampleRaw = Invoke-Curl @('-sS', $sampleUrl)
  Add-Section '3) orders/sample' ("GET " + $sampleUrl + "`n" + $sampleRaw)
} catch {
  Add-Section '3) orders/sample' ("GET " + $sampleUrl + "`nERROR " + $_.Exception.Message)
}

$sampleJson = Json-TryParse $sampleRaw
$pkgId = $null
$ctn = $null
$ctnCarrier = $null
$cid = $null
if ($sampleJson -ne $null) {
  foreach ($k in @('forLabel','sample','firstAny','forInvoice')) {
    if ($sampleJson.PSObject.Properties.Name -contains $k) {
      $obj = $sampleJson.$k
      if ($obj -ne $null) {
        $pkgCandidate = Get-PropValue $obj 'shipmentPackageId'
        $ctnCandidate = Get-PropValue $obj 'cargoTrackingNumber'
        $cidCandidate = Get-PropValue $obj 'connectionId'
        $carrierCandidate = Get-PropValue $obj 'carrier'

        if (-not $pkgId -and $pkgCandidate) { $pkgId = $pkgCandidate }
        if (-not $ctn -and $ctnCandidate) { $ctn = $ctnCandidate }
        if (-not $ctnCarrier -and $carrierCandidate) { $ctnCarrier = $carrierCandidate }
        if (-not $cid -and $cidCandidate) { $cid = $cidCandidate }
      }
    }
  }
}

# Prefer pickedConnection.id (handler returns pickedConnection:{id,name,status,...})
if (-not $cid -and $sampleJson -ne $null) {
  try {
    if ($sampleJson.pickedConnection -and $sampleJson.pickedConnection.id) {
      $cid = [string]$sampleJson.pickedConnection.id
    }
  } catch { }
}

$isMarketplaceCarrier = $false
if ($ctnCarrier) {
  $lcCarrier = ([string]$ctnCarrier).ToLowerInvariant()
  if ($lcCarrier -like '*marketplace*') { $isMarketplaceCarrier = $true }
}

# NOTE: We keep marketplace cargos too. Some accounts only have Marketplace carriers in the last 90 days.
# We'll first try strict TEX/ARAS discovery, and if that fails we retry with Marketplace included.

# 4) Promote package to Picking/Invoiced (optional)
if ($pkgId) {
  $promoteUrl = $LocalBase + ('/v1/sprint11/shipment-packages/{0}/promote' -f $pkgId)
  if ($cid) { $promoteUrl += ('?connectionId=' + $cid) }
  try {
    $promoteRaw = Invoke-Curl @('-sS','-X','POST', $promoteUrl)
    Add-Section '4) shipment-packages/:id/promote' ("POST " + $promoteUrl + "`n" + $promoteRaw)
  } catch {
    Add-Section '4) shipment-packages/:id/promote' ("POST " + $promoteUrl + "`nERROR " + $_.Exception.Message)
  }
} else {
  Add-Section '4) shipment-packages/:id/promote' 'SKIP (no shipmentPackageId found)'
}

# 5) CommonLabel ensure + get
# Important: Always enable server-side discovery so we can try alternative cargos if the first one fails.
$ensureUrl = $LocalBase + '/v1/sprint11/labels/common/ensure?dryRun=0&createFirst=1&probeLegacy=0&maxAttempts=8&discoverAlternatives=1&includeNoStatus=1&carrier=TEX,ARAS&statuses=Picking,Invoiced,ReadyToShip,Shipped&lookbackDays=90'
# If sample carrier is Marketplace, don't seed strict ensure with it; try discovery first.
if ($ctn -and (-not $isMarketplaceCarrier)) { $ensureUrl += ('&cargoTrackingNumber=' + [string]$ctn) }
if ($cid) { $ensureUrl += ('&connectionId=' + [string]$cid) }

$ensRaw = ''
$ensJson = $null
$ctnUsed = $null
try {
  $ensRaw = Invoke-Curl @('-sS', $ensureUrl)
  Add-Section '5) labels/common/ensure (dryRun=0)' ("GET " + $ensureUrl + "`n" + $ensRaw)
  $ensJson = Json-TryParse $ensRaw
  if ($ensJson -ne $null) {
    $ok = Get-PropValue $ensJson 'ok'
    if ($ok -eq $true) {
      $ctnUsed = Get-PropValue $ensJson 'cargoTrackingNumber'
    }
  }
} catch {
  Add-Section '5) labels/common/ensure (dryRun=0)' ("GET " + $ensureUrl + "`nERROR " + $_.Exception.Message)
}

# Retry with Marketplace included if strict discovery failed and we only have Marketplace carrier in the last 90 days.
if (-not $ctnUsed -and $isMarketplaceCarrier -and $ctn) {
  $ensureUrl2 = $LocalBase + '/v1/sprint11/labels/common/ensure?dryRun=0&createFirst=1&probeLegacy=0&maxAttempts=8&discoverAlternatives=1&includeNoStatus=1&carrier=TEX,ARAS,Marketplace&statuses=Picking,Invoiced,ReadyToShip,Shipped&lookbackDays=90'
  $ensureUrl2 += ('&cargoTrackingNumber=' + [string]$ctn)
  if ($cid) { $ensureUrl2 += ('&connectionId=' + [string]$cid) }

  try {
    $ensRaw2 = Invoke-Curl @('-sS', $ensureUrl2)
    Add-Section '5b) labels/common/ensure retry (Marketplace)' ("GET " + $ensureUrl2 + "`n" + $ensRaw2)
    $ensJson2 = Json-TryParse $ensRaw2
    if ($ensJson2 -ne $null) {
      $ok2 = Get-PropValue $ensJson2 'ok'
      if ($ok2 -eq $true) {
        $ctnUsed = Get-PropValue $ensJson2 'cargoTrackingNumber'
      }
    }
  } catch {
    Add-Section '5b) labels/common/ensure retry (Marketplace)' ("GET " + $ensureUrl2 + "`nERROR " + $_.Exception.Message)
  }
}

if (-not $ctnUsed) { $ctnUsed = $ctn }
if ($ctnUsed) {
  # PDF acceptance target: getCommonLabel -> 2xx + ZPL content.
  # Use the /download variant so the proof includes raw ZPL (text/plain).
  $getUrl = $LocalBase + ('/v1/sprint11/labels/common/{0}/download' -f $ctnUsed)
  if ($cid) { $getUrl += ('?connectionId=' + [string]$cid) }
  try {
    $getRaw = Invoke-Curl @('-sS','-i', $getUrl)
    Add-Section '6) labels/common/:cargoTrackingNumber (download ZPL)' ("GET " + $getUrl + "`n" + $getRaw)
  } catch {
    Add-Section '6) labels/common/:cargoTrackingNumber (download ZPL)' ("GET " + $getUrl + "`nERROR " + $_.Exception.Message)
  }
} else {
  Add-Section '6) labels/common/:cargoTrackingNumber (download ZPL)' 'SKIP (no cargoTrackingNumber found and ensure did not succeed)'
}

# 6) Invoice submit (publish + seller-invoice-links + seller-invoice-file)
if ($pkgId) {
  $invUrl = $LocalBase + ('/v1/sprint11/invoices/submit?dryRun=0&shipmentPackageId={0}' -f $pkgId)
  if ($cid) { $invUrl += ('&connectionId=' + $cid) }
  if (-not $PublicBase) {
    # still call; server will use host header; but we record the risk
    $invNote = "(NOTE) ECI_PUBLIC_BASE_URL missing; invoiceLink may not be publicly reachable."
  } else {
    $invNote = "ECI_PUBLIC_BASE_URL=" + $PublicBase
  }

  try {
    $invRaw = Invoke-Curl @('-sS','-i','-X','POST',
      '-H','Content-Type: application/pdf',
      '-H','x-filename: invoice.pdf',
      '--data-binary',('@' + $TmpPdf),
      $invUrl)
    Add-Section '7) invoices/submit (dryRun=0)' ($invNote + "`nPOST " + $invUrl + "`n" + $invRaw)
  } catch {
    Add-Section '7) invoices/submit (dryRun=0)' ("POST " + $invUrl + "`nERROR " + $_.Exception.Message)
  }
} else {
  Add-Section '7) invoices/submit (dryRun=0)' 'SKIP (no shipmentPackageId found)'
}

# 6b) Verify invoiceLink reachable (HEAD)
# We do a best-effort parse of invoiceLink from curl -i output.
try {
  if ($pkgId) {
    $invOut = $null
    # Find the last recorded invoices/submit block in the proof buffer (we keep invRaw in variable scope)
    # If invRaw exists, attempt to parse JSON body.
    if (Get-Variable -Name invRaw -Scope Script -ErrorAction SilentlyContinue) {
      $invOut = $invRaw
    }
    if ($invOut) {
      $body = $invOut
      # split headers/body (handles \r\n\r\n and \n\n)
      if ($body -match "`r`n`r`n") { $body = ($body -split "`r`n`r`n", 2)[1] }
      elseif ($body -match "`n`n") { $body = ($body -split "`n`n", 2)[1] }

      $j = Json-TryParse $body
      $invoiceLink = $null
      if ($j -and $j.invoiceLink) { $invoiceLink = [string]$j.invoiceLink }

      if ($invoiceLink) {
        $headRaw = Invoke-Curl @('-sS','-I',$invoiceLink)
        $extra = ''
        if ($PublicBase -and $invoiceLink.StartsWith($PublicBase)) {
          $localLink = $invoiceLink.Replace($PublicBase, $LocalBase)
          $localHead = Invoke-Curl @('-sS','-I',$localLink)
          $extra = "`n`nHEAD (local) " + $localLink + "`n" + $localHead
        }
        Add-Section '7b) invoiceLink HEAD' ("HEAD " + $invoiceLink + "`n" + $headRaw + $extra)
      } else {
        Add-Section '7b) invoiceLink HEAD' 'SKIP (invoiceLink not parsed from invoices/submit output)'
      }
    } else {
      Add-Section '7b) invoiceLink HEAD' 'SKIP (no invoices/submit output captured)'
    }
  } else {
    Add-Section '7b) invoiceLink HEAD' 'SKIP (no shipmentPackageId found)'
  }
} catch {
  Add-Section '7b) invoiceLink HEAD' ("ERROR " + $_.Exception.Message)
}

# 7) Summary
$null = $sb.AppendLine('## 8) Summary')
$null = $sb.AppendLine('~~~')
$null = $sb.AppendLine(('shipmentPackageId=' + [string]$pkgId))
$ctnSummary = $ctnUsed
if (-not $ctnSummary) { $ctnSummary = $ctn }
$null = $sb.AppendLine(('cargoTrackingNumber=' + [string]$ctnSummary))
$null = $sb.AppendLine(('connectionId=' + [string]$cid))
$null = $sb.AppendLine('~~~')
$null = $sb.AppendLine('')

$finalTxt = $sb.ToString()
$finalEnc = (New-Object System.Text.UTF8Encoding($false))
[IO.File]::WriteAllText($ProofPath, $finalTxt, $finalEnc)
if ($CoreProofPath) { [IO.File]::WriteAllText($CoreProofPath, $finalTxt, $finalEnc) }
Write-Host ("WROTE " + $ProofPath)
if ($CoreProofPath) { Write-Host ("WROTE " + $CoreProofPath) }
