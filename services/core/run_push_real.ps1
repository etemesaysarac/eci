$ErrorActionPreference = "Stop"

$BASE="http://127.0.0.1:3001"
$CONN="cmk28anrb0000e6gwaprps4hn"
$BARCODE="8417781987254"

# 0) Ön kontrol: API/Worker ayakta mı?
$h = curl.exe -s "$BASE/health"
Write-Host "health=$h"

# 1) DB’de bu barkodun raw’ını bul
$sql = @"
select raw
from "ProductVariant"
where raw->>'barcode' = '$BARCODE'
limit 1;
"@
$rawText = ($sql | docker exec -i infra-postgres-1 psql -U eci -d eci -t -A)

if ([string]::IsNullOrWhiteSpace($rawText)) {
  throw "DB’de barkod bulunamadı: $BARCODE. Önce TRENDYOL_SYNC_PRODUCTS çalıştırmak gerekir."
}

$rawText | Out-File .\variant_raw_real.json -Encoding utf8
$raw = Get-Content .\variant_raw_real.json -Raw | ConvertFrom-Json

# 2) Zorunlu alanları güvenli hazırla (elseif yok)
$categoryId = $null
if ($raw.categoryId) { $categoryId = [int]$raw.categoryId }
if (-not $categoryId -and $raw.pimCategoryId) { $categoryId = [int]$raw.pimCategoryId }
if (-not $categoryId) { throw "categoryId/pimCategoryId yok" }

$brandId = $null
if ($raw.brandId) { $brandId = [int]$raw.brandId }
if (-not $brandId) { throw "brandId yok" }

$desc = $raw.description
if ([string]::IsNullOrWhiteSpace($desc)) { $desc = $raw.title }

$cargoCompanyId = $null
if ($raw.cargoCompanyId) { $cargoCompanyId = [int]$raw.cargoCompanyId }

$dimW = $null
if ($raw.dimensionalWeight) { $dimW = [double]$raw.dimensionalWeight }

$images = @()
if ($raw.images) { $images = $raw.images }

$attrs = @()
if ($raw.attributes) {
  $attrs = $raw.attributes | ForEach-Object { @{ attributeId=$_.attributeId; attributeValueId=$_.attributeValueId } }
}

# 3) No-op update payload (mevcut değerleri tekrar gönderiyoruz)
$payload = @{
  items = @(
    @{
      barcode           = $raw.barcode
      title             = $raw.title
      description       = $desc
      productMainId     = $raw.productMainId
      brandId           = $brandId
      categoryId        = $categoryId
      quantity          = [int]$raw.quantity
      stockCode         = $raw.stockCode
      dimensionalWeight = $dimW
      currencyType      = "TRY"
      listPrice         = [double]$raw.listPrice
      salePrice         = [double]$raw.salePrice
      vatRate           = [int]$raw.vatRate
      cargoCompanyId    = $cargoCompanyId
      images            = $images
      attributes        = $attrs
    }
  )
}

$payload | ConvertTo-Json -Depth 30 | Out-File .\push_update_real.json -Encoding utf8

# 4) Enqueue
$pushText = curl.exe -s -X POST "$BASE/v1/connections/$CONN/push/products?action=update" `
  -H "content-type: application/json" `
  --data-binary "@push_update_real.json"

$pushText | Out-File .\proof_push_update_real.json -Encoding utf8
$jobId = ($pushText | ConvertFrom-Json).jobId
if ([string]::IsNullOrWhiteSpace($jobId)) { throw "jobId gelmedi: proof_push_update_real.json kontrol et" }
Write-Host "jobId=$jobId"

# 5) Status poll (final)
$final=$null
for ($i=0; $i -lt 60; $i++) {
  $stText = curl.exe -s "$BASE/v1/connections/$CONN/status"
  $stText | Out-File .\proof_status_after_update_real.json -Encoding utf8
  $st = $stText | ConvertFrom-Json

  if ($st.lastJob -and $st.lastJob.id -eq $jobId -and $st.lastJob.status -ne "running") {
    $final = $st.lastJob
    break
  }
  Start-Sleep -Seconds 2
}
if (-not $final) { throw "Status timeout" }

Write-Host "finalStatus=$($final.status)"
if ($final.status -ne "success") { throw $final.error }

$batchId = $final.summary.batchRequestId
Write-Host "batchRequestId=$batchId"

# 6) Batch result (connectionId garanti)
$batchText = curl.exe -sG "$BASE/v1/trendyol/products/batch-requests/$batchId" `
  --data-urlencode "connectionId=$CONN"

$batchText | Out-File .\proof_batch_result_real.json -Encoding utf8
Write-Host "Saved: proof_batch_result_real.json"
