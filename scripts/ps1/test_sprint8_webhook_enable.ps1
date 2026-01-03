param(
  [string]$BaseUrl = "http://127.0.0.1:3001",
  [Parameter(Mandatory=$true)][string]$ConnectionId,
  [ValidateSet("API_KEY","BASIC_AUTHENTICATION")][string]$AuthenticationType = "API_KEY"
)

$ErrorActionPreference = "Stop"

function Invoke-PostJson([string]$Url, $BodyObj) {
  $body = $BodyObj | ConvertTo-Json -Depth 10 -Compress
  try {
    $r = Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json" -Body $body
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

$url = "{0}/v1/connections/{1}/webhooks/enable" -f $BaseUrl,$ConnectionId
Write-Host ("POST {0}" -f $url) -ForegroundColor Cyan

$res = Invoke-PostJson $url @{ authenticationType=$AuthenticationType }

if ($res.ok) {
  Write-Host "OK" -ForegroundColor Green
  $res.body | ConvertTo-Json -Depth 12
  Write-Host "`nNOTE:" -ForegroundColor Yellow
  Write-Host " - Receiver header for API_KEY:  x-api-key: <apiKey>"
  Write-Host " - Receiver header for BASIC:    Authorization: Basic base64(username:password)"
} else {
  Write-Host ("FAIL HTTP {0}" -f $res.status) -ForegroundColor Red
  if ($res.body) { $res.body | ConvertTo-Json -Depth 12 } else { $res.message }
}
