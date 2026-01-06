# ECI — Sprint 9 Patch (SYNC_PRODUCTS + /v1/products)

Bu patch şunları ekler:

1) **API:** `POST /v1/connections/:id/sync/products` → worker’a `TRENDYOL_SYNC_PRODUCTS` job’u enqueue eder.
2) **Worker:** `TRENDYOL_SYNC_PRODUCTS` job handler → Trendyol’dan ürünleri çeker ve DB’ye upsert eder.
3) **API:** `GET /v1/products` → DB’den ürünleri sayfalı biçimde listeler (panel endpoint’i).

## Neden gerekli?

Mevcut kodda `GET /v1/trendyol/products` (proxy) var ama **DB’ye yazan “SYNC_PRODUCTS” endpoint/job yoktu**. 
Bu yüzden sen doğru olarak `POST /v1/connections/{id}/sync/products` denediğinde `404 {"error":"not_found"}` görüyordun.

## Patch nasıl uygulanır?

Bu zip’i repo kök dizinine **üzerine yazarak** aç:

- Windows: Sağ tık → Extract Here (mevcut dosyaların üzerine yazmayı kabul et)

Değişen dosyalar:
- `services/core/src/eci/server.ts`
- `services/core/src/eci/worker.ts`
- `services/core/src/eci/server.sprint9.ts`

## Çalıştırma (kanıt odaklı)

### 0) Infra
```powershell
cd C:\dev\eci\services\core
docker ps
```

### 1) API + Worker (2 ayrı terminal)
```powershell
cd C:\dev\eci\services\core
npm run eci:api
```

```powershell
cd C:\dev\eci\services\core
npm run eci:worker
```

Health:
```powershell
curl.exe -i "http://127.0.0.1:3001/health"
```

### 2) Connection ID’yi gör (API üzerinden)
```powershell
curl.exe -s "http://127.0.0.1:3001/v1/connections"
```

### 3) (Opsiyonel) Trendyol’dan direkt ürün oku (proxy)
Bu adım credential’ların iyi olduğuna dair hızlı kanıt verir (DB’ye yazmaz):
```powershell
$CONN="CONNECTION_ID"
curl.exe -i "http://127.0.0.1:3001/v1/trendyol/products?connectionId=$CONN&approved=true&page=0&size=10"
```

### 4) SYNC_PRODUCTS (DB’ye yaz)
```powershell
$CONN="CONNECTION_ID"

@'
{
  "pageSize": 50,
  "includeApproved": true,
  "includeUnapproved": true
}
'@ | Set-Content -Encoding UTF8 sync_products.json

curl.exe -i -X POST "http://127.0.0.1:3001/v1/connections/$CONN/sync/products" `
  -H "Content-Type: application/json" `
  --data-binary "@sync_products.json"
```

Bu endpoint bir `jobId` döner. Worker logunda `TRENDYOL_SYNC_PRODUCTS` görmelisin.

### 5) DB kanıt
```powershell
$sql = @'
select count(*) as products from "Product";
select count(*) as variants from "ProductVariant";
'@
$sql | docker exec -i infra-postgres-1 psql -U eci -d eci -v ON_ERROR_STOP=1
```

### 6) Panel endpoint kanıtı
```powershell
curl.exe -i "http://127.0.0.1:3001/v1/products?connectionId=$CONN&page=0&size=50"
```

## Notlar

- PowerShell’de **curl değil `curl.exe`** kullanıyoruz (alias tuzağı).
- Ürün upsert’leri şimdilik “best-effort”: Trendyol response shape farklı olsa bile sonsuz loop’a girmesin diye güvenlik limitleri var.
- Lock aynı connection üzerinde tek sync’e izin verir (orders/products aynı lock’u paylaşır).
