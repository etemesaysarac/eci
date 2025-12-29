\
param(
  [Parameter(Mandatory=$false)]
  [string]$EnvPath = "C:\dev\eci\services\core\.env",

  [switch]$Stage,
  [switch]$AlsoSapigw
)

# 1) Load .env into current process
. (Join-Path $PSScriptRoot "load_env.ps1") -Path $EnvPath

# 2) Read env
$sellerId  = $env:TRENDYOL_SELLER_ID
$apiKey    = $env:TRENDYOL_API_KEY
$apiSecret = $env:TRENDYOL_API_SECRET
$suffix    = $env:TRENDYOL_USER_AGENT_SUFFIX

if (-not $sellerId -or -not $apiKey -or -not $apiSecret) {
  Write-Host "ENV eksik. Gerekli: TRENDYOL_SELLER_ID, TRENDYOL_API_KEY, TRENDYOL_API_SECRET" -ForegroundColor Yellow
  Write-Host "Kontrol: $EnvPath" -ForegroundColor Yellow
  return
}

if (-not $suffix) { $suffix = "SoXYZ-ECI" }

$baseUrl = if ($Stage) { $env:TRENDYOL_STAGE_BASE_URL } else { $env:TRENDYOL_BASE_URL }
if (-not $baseUrl) { $baseUrl = "https://apigw.trendyol.com" }

$sapigwBase = $env:TRENDYOL_SAPIGW_BASE_URL
if (-not $sapigwBase) { $sapigwBase = "https://api.trendyol.com/sapigw" }

$pair  = "$apiKey`:$apiSecret"
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$userAgent = "$sellerId - $suffix"

function Hit([string]$title, [string]$url) {
  Write-Host "`n==> $title" -ForegroundColor Cyan
  Write-Host "    $url" -ForegroundColor DarkGray

  $out = Join-Path $env:TEMP "eci_trendyol_resp.json"

  curl.exe -sS -o $out -w "HTTP %{http_code}`n" `
    $url `
    -H "Authorization: Basic $basic" `
    -H "User-Agent: $userAgent" `
    -H "Content-Type: application/json"

  if (Test-Path $out) { Get-Content $out -TotalCount 60 }
}

# --- 3 endpoint ile hızlı teşhis (apigw/integration) ---
Hit "Webhooks (apigw)" "$baseUrl/integration/webhook/sellers/$sellerId/webhooks"
Hit "Shipment packages (apigw)" "$baseUrl/integration/order/sellers/$sellerId/shipment-packages?status=Created&size=1&page=0"
Hit "Orders (apigw)" "$baseUrl/integration/order/sellers/$sellerId/orders?status=Created&size=1&page=0"

if ($AlsoSapigw) {
  # Bazı dökümanlarda /sapigw/suppliers/... kullanılıyor.
  Hit "Shipment packages (sapigw)" "$sapigwBase/suppliers/$sellerId/shipment-packages?status=Created&size=1&page=0"
  Hit "Orders (sapigw)" "$sapigwBase/suppliers/$sellerId/orders?status=Created&size=1&page=0"
}
