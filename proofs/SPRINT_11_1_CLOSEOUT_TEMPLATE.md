# ECI — Sprint 11.1 Closeout (Template)

Bu dosya, Sprint 11.1 kapanışı için kanıt paketinin hangi maddeleri içermesi gerektiğini özetler.

## Zorunlu Kanıtlar

1) **API ayakta**
- `GET /health` (local) -> **200**
- `GET $ECI_PUBLIC_BASE_URL/health` (public) -> **200** (Cloudflare 1033 vb yok)

2) **Sample discovery (ID bulma)**
- `GET /v1/sprint11/orders/sample?carriers=TEX,ARAS&statuses=...&lookbackDays<=90` -> 200
- response içinden `connectionId`, `shipmentPackageId`, `cargoTrackingNumber` alınır.

3) **Promote (Picking/Invoiced)**
- `POST /v1/sprint11/shipment-packages/:id/promote` -> 200

4) **CommonLabel (ZPL)**
- `GET /v1/sprint11/labels/common/ensure?...&dryRun=0` -> 200 + `zplPreview` dolu
- `GET /v1/sprint11/labels/common/:cargoTrackingNumber/download` -> 200 + .zpl dosyası

5) **Invoice (public invoiceLink + Trendyol submit)**
- `POST /v1/sprint11/invoices/submit?...&dryRun=0` -> 200
- response içinde `invoiceLink` **public domain** olmalı
- `GET invoiceLink` -> 200 + `Content-Type: application/pdf`

---

## Notlar
- Trendyol sipariş sorgularında tarih aralığı pratikte **14 günlük window** ile parçalı taranmalıdır.
- invoiceNumber formatı PDF standardına uygun olmalıdır (API bunu normalize eder).
- Eğer Trendyol upstream 556/503 dönerse (kargo etiketi gibi), bu entegrasyon tarafında değil Trendyol tarafında geçici sorundur.
