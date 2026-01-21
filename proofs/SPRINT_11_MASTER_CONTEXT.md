# ECI — Sprint 11 (Fatura Linki / Seller Invoice / Label) — MASTER CONTEXT

> Bu dosya Sprint 11’i **hızlı**, **kanıta dayalı** ve **Trendyol.pdf’e sadık** şekilde kapatmak için: başlangıç + test sırası + kanıt formatı.

## 0) Mini Bulut (hedef görüntü)
- Infra: Docker Postgres + Redis ✅
- API: /health ✅
- Worker: (Sprint 11 için opsiyonel) ✅

## 1) Sprint 11 Amaç
Gerçek operasyon: **kargo etiketi (ZPL)** ve **fatura** (link + dosya) akışını ECI üzerinden yönetmek.

Trendyol.pdf referans servisleri:
- **Seller addresses**: `GET /integration/sellers/{sellerId}/addresses`
- **Common label**: `POST` + `GET` `/integration/sellers/{sellerId}/commonlabel/{cargoTrackingNumber}`
- **Invoice link**: `POST /integration/sellers/{sellerId}/seller-invoice-links`
- **Invoice link delete**: `POST /integration/sellers/{sellerId}/seller-invoice-links/delete`
- **Invoice file upload**: `POST /integration/sellers/{sellerId}/seller-invoice-file` (multipart)

## 2) Roller
- **Etem (stajyer)**: Komutları çalıştırır, kanıtları (curl.exe / log / DB/file) gönderir.
- **Asistan (baş mühendis)**: Debug eder, gerekirse patch ZIP üretir (**sadece değişen dosyalar**).

## 3) Kanıt Standardı (her adım için)
1) `curl.exe -i` çıktısı (HTTP status + body)
2) (Opsiyonel) API log snippet
3) (Sprint 11 özel) **dosya kanıtı**: `outputs/sprint11/...` altında oluşan dosya + meta json

> PowerShell notu: `curl` alias olabilir. **Her zaman `curl.exe`**.

## 4) Sprint 11.1 — En Kısa Kapanış Planı (PDF standardında)

### A) CommonLabel (hedef: getCommonLabel → 2xx + ZPL)
1) **Uygun paket bul/dene** (sistemde env varsa onu kullanır, yoksa keşfe çıkar):
   - `GET  $env:ECI_PUBLIC_BASE_URL/v1/sprint11/labels/common/ensure?dryRun=0`
   - Beklenen: `result.get.status` 2xx + `downloadUrl` döner.

2) **Download (ZPL içerik kanıtı)**
   - `GET  <downloadUrl>`
   - Beklenen: body içinde ZPL metni.

> Not: CommonLabel için en stabil senaryo: Trendyol Express / Aras gibi PDF’te sorunsuz çalıştığı ima edilen taşıyıcı ve **Picking / Invoiced sonrası**.

### B) Invoice (hedef: Trendyol’un erişebileceği gerçek invoiceLink + 2 adet 2xx)

Bu patch ile **public invoiceLink** için API içinde dosya serve ediyoruz:
- Public route: `GET /v1/sprint11/public/invoices/{connectionId}/{shipmentPackageId}/{filename}`
- Base URL: **`ECI_PUBLIC_BASE_URL`** (ör. `https://eci.goeasyso.com`) kullanılır.

3) **Tek çağrıda kapanış (önerilen)** — publish + seller-invoice-links + seller-invoice-file
   - Komut:

```powershell
# PDF (binary) dosyanı gönder (ör: invoice.pdf)
curl.exe -i -X POST "$env:ECI_PUBLIC_BASE_URL/v1/sprint11/invoices/submit?dryRun=0&shipmentPackageId=$env:ECI_S11_SHIPMENT_PACKAGE_ID" `
  -H "Content-Type: application/pdf" `
  --data-binary "@invoice.pdf"
```

Beklenen:
- `invoiceLinkResult.status` 2xx
- `invoiceFileResult.status` 2xx
- Ayrıca `outputs/sprint11/invoices/...` altında dosya + meta json

4) (İstersen parça parça)
   - **publish** (dosyayı sakla + invoiceLink üret):

```powershell
curl.exe -i -X POST "$env:ECI_PUBLIC_BASE_URL/v1/sprint11/invoices/file/publish?shipmentPackageId=$env:ECI_S11_SHIPMENT_PACKAGE_ID" `
  -H "Content-Type: application/pdf" `
  --data-binary "@invoice.pdf"
```

   - **seller-invoice-links**:

```powershell
# publish çıktısından invoiceLink alıp JSON’a koy
curl.exe -i -X POST "$env:ECI_PUBLIC_BASE_URL/v1/sprint11/invoices/link?dryRun=0" `
  -H "Content-Type: application/json" `
  -d '{"connectionId":"'$env:ECI_S11_CONNECTION_ID'","shipmentPackageId":'$env:ECI_S11_SHIPMENT_PACKAGE_ID',"invoiceLink":"<PUBLISH_DONEN_LINK>"}'
```

   - **seller-invoice-file**:

```powershell
curl.exe -i -X POST "$env:ECI_PUBLIC_BASE_URL/v1/sprint11/invoices/file/raw?dryRun=0&connectionId=$env:ECI_S11_CONNECTION_ID&shipmentPackageId=$env:ECI_S11_SHIPMENT_PACKAGE_ID" `
  -H "Content-Type: application/pdf" `
  --data-binary "@invoice.pdf"
```

> Not: `invoiceDateTime` ve `invoiceNumber` alanlarını API **normalize eder** (invoiceDateTime = UNIX seconds; invoiceNumber = PDF formatı). Elle ms/ECI-xxx verirsen bile server düzeltmeye çalışır.

## 5) Kapanış Kriteri (Sprint 11.1 “tereyağından kıl çeker gibi”)
- CommonLabel: get → 2xx + ZPL ✅
- Invoice: seller-invoice-links → 2xx ✅
- Invoice: seller-invoice-file → 2xx ✅
- Kanıt: `services/core/proofs/SPRINT_11_PROOF.md` + outputs dosyaları ✅
