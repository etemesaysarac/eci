param(
  [string]$BaseUrl = "http://127.0.0.1:3001",
  [Parameter(Mandatory=$true)][string]$ApiKey
)

$ErrorActionPreference = "Stop"

function Invoke-PostRawJson([string]$Url, [string]$Json, [hashtable]$Headers) {
  try {
    $r = Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json" -Headers $Headers -Body $Json
    return @{ ok=$true; status=200; body=$r }
  } catch {
    $status = 0
    try { $status = [int]$_.Exception.Response.StatusCode.value__ } catch {}
    $msg = $_.Exception.Message
    $errBody = $null
    try { if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $errBody = ($_.ErrorDetails.Message | ConvertFrom-Json) } } catch {}
    return @{ ok=$false; status=$status; body=$errBody; message=$msg }
  }
}

$url = "{0}/v1/webhooks/trendyol" -f $BaseUrl
$headers = @{ "x-api-key" = $ApiKey }

# Minimal, deterministic payload (same payload twice => dedup on 2nd call)
$payload = @{
  eventType = "ShipmentPackageStatusChanged"
  orderNumber = "TEST_ORDER_123"
  shipmentPackageId = "TEST_PACKAGE_123"
  status = "Created"
  occurredAt = (Get-Date).ToString("s")
} | ConvertTo-Json -Depth 10 -Compress

Write-Host ("POST {0} (1st)" -f $url) -ForegroundColor Cyan
$r1 = Invoke-PostRawJson $url $payload $headers
if ($r1.ok) { Write-Host "OK" -ForegroundColor Green; $r1.body | ConvertTo-Json -Depth 12 } else { Write-Host ("FAIL HTTP {0}" -f $r1.status) -ForegroundColor Red; if ($r1.body) { $r1.body | ConvertTo-Json -Depth 12 } else { $r1.message } }

Write-Host ("`nPOST {0} (2nd - same payload => expected dedup)" -f $url) -ForegroundColor Cyan
$r2 = Invoke-PostRawJson $url $payload $headers
if ($r2.ok) { Write-Host "OK" -ForegroundColor Green; $r2.body | ConvertTo-Json -Depth 12 } else { Write-Host ("FAIL HTTP {0}" -f $r2.status) -ForegroundColor Red; if ($r2.body) { $r2.body | ConvertTo-Json -Depth 12 } else { $r2.message } }
