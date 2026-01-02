param(
  [string]$BaseUrl = "http://127.0.0.1:3001",
  [Parameter(Mandatory=$true)][string]$ConnectionId,
  [Parameter(Mandatory=$true)][string]$PackageId,
  [Parameter(Mandatory=$true)][long]$LineId,
  [switch]$SkipUnsupplied
)

$ErrorActionPreference = "Stop"

$here = if ($PSScriptRoot) { $PSScriptRoot } else { (Resolve-Path ".\scripts\ps1").Path }
. (Join-Path $here "expected_errors.ps1")

function Try-ReadJsonFromError($_err) {
  try {
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { return ($_.ErrorDetails.Message | ConvertFrom-Json) }
  } catch {}
  return $null
}

function Invoke-PostJson([string]$Url, $BodyObj) {
  $body = $BodyObj | ConvertTo-Json -Depth 10 -Compress
  try {
    $r = Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json" -Body $body
    return @{ ok=$true; status=200; body=$r; raw=$null }
  } catch {
    $status = 0
    try { $status = [int]$_.Exception.Response.StatusCode.value__ } catch {}
    $bj = Try-ReadJsonFromError $_
    return @{ ok=$false; status=$status; body=$bj; raw=$_.Exception.Message }
  }
}

$sum = New-Object System.Collections.Generic.List[object]

Write-Host "Actions test (7.2)..." -ForegroundColor Cyan

# 1) updateTrackingNumber (expected 400 olabilir)
$u1 = "{0}/v1/connections/{1}/shipment-packages/{2}/actions/update-tracking-number" -f $BaseUrl,$ConnectionId,$PackageId
$r1 = Invoke-PostJson $u1 @{ trackingNumber="TEST123"; cargoProvider="DHL" }
$k1 = Resolve-ExpectedError -Status $r1.status -BodyJson $r1.body
$sum.Add([pscustomobject]@{ action="updateTrackingNumber"; http=$r1.status; result=($r1.ok?"OK":$k1.classification); label=($r1.ok?"OK":$k1.label) })

# 2) updatePackage Picking
$u2 = "{0}/v1/connections/{1}/shipment-packages/{2}/actions/update-package?refetch=1" -f $BaseUrl,$ConnectionId,$PackageId
$r2 = Invoke-PostJson $u2 @{ status="Picking"; lines=@(@{lineId=$LineId;quantity=1}); params=@{} }
$k2 = Resolve-ExpectedError -Status $r2.status -BodyJson $r2.body
$sum.Add([pscustomobject]@{ action="updatePackage(Picking)"; http=$r2.status; result=($r2.ok?"OK":$k2.classification); label=($r2.ok?"OK":$k2.label) })

# 3) updatePackage Invoiced
$r3 = Invoke-PostJson $u2 @{ status="Invoiced"; lines=@(@{lineId=$LineId;quantity=1}); params=@{} }
$k3 = Resolve-ExpectedError -Status $r3.status -BodyJson $r3.body
$sum.Add([pscustomobject]@{ action="updatePackage(Invoiced)"; http=$r3.status; result=($r3.ok?"OK":$k3.classification); label=($r3.ok?"OK":$k3.label) })

# 4) unsupplied (opsiyonel)
if (-not $SkipUnsupplied) {
  $u4 = "{0}/v1/connections/{1}/shipment-packages/{2}/actions/unsupplied" -f $BaseUrl,$ConnectionId,$PackageId
  $r4 = Invoke-PostJson $u4 @{ lines=@(@{lineId=$LineId;quantity=1}); reasonId=500 }
  $k4 = Resolve-ExpectedError -Status $r4.status -BodyJson $r4.body
  $sum.Add([pscustomobject]@{ action="unsupplied"; http=$r4.status; result=($r4.ok?"OK":$k4.classification); label=($r4.ok?"OK":$k4.label) })
}

Write-Host "`nSUMMARY" -ForegroundColor Green
$sum | Format-Table -AutoSize
