$ErrorActionPreference = "Stop"
# Parametreler (test hesabı)
$API    = "qnDpoF47eWsOIFqfeAHx"
$SECRET = "VNBVYPi3pLnwS7t1ntxm"
$SELLER = "142312"
$UA     = "$SELLER - ECI"

# Fake paket
$PKG = "999999999"

Write-Host ">> Trendyol: GET orders (read kontrol)"
curl.exe -i -u "$API`:$SECRET" -H "User-Agent: $UA" "https://apigw.trendyol.com/integration/order/sellers/$SELLER/orders?status=Created&page=0&size=1"

Write-Host "`n>> Trendyol: sellers/update-box-info (WRITE kontrol, hedef: 401 -> 404)"
curl.exe -i -u "$API`:$SECRET" -H "User-Agent: $UA" -H "Content-Type: application/json" --data '{""boxCount"":1}' "https://apigw.trendyol.com/integration/order/sellers/$SELLER/shipment-packages/$PKG/update-box-info"

# Bizim API üstünden aynı WRITE (fallback sellers->suppliers devrede)
$CID = "cmju5r9cv000qe6x07ke409ni"
$body = '{ "boxCount": 1 }'

Write-Host "`n>> Bizim API: update-box-info (fake paket; hedef: 404 NotFound)"
curl.exe -i -X POST -H "Content-Type: application/json" --data $body "http://127.0.0.1:3001/v1/connections/$CID/shipment-packages/$PKG/actions/update-box-info"
