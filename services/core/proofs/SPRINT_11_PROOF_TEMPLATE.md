# ECI — Sprint 11 Proof Pack (Template)

> Bu dosya bir **şablondur**. Otomatik üretim için `npm run eci:proof11` kullan.

## 0) Infra
- docker ps

## 1) API Health
- GET /health

## 2) Connection
- GET /v1/connections (picked connectionId)
- GET /v1/connections/:id/status

## 3) Seller Addresses (getSuppliersAddresses)
- GET /v1/sprint11/seller/addresses?connectionId=...

## 4) Sample Order Discovery
- GET /v1/sprint11/orders/sample?connectionId=...&status=Picking
- cargoTrackingNumber, shipmentPackageId, customerId

## 5) Common Label
- GET /v1/sprint11/labels/common/{cargoTrackingNumber}?connectionId=...
- GET /v1/sprint11/labels/common/{cargoTrackingNumber}/download?connectionId=...
- POST /v1/sprint11/labels/common/create (dryRun=1 → real)

## 6) Invoice Link
- POST /v1/sprint11/invoices/link (dryRun=1 → real)
- POST /v1/sprint11/invoices/link/delete (dryRun=1 → real)

## 7) Invoice File
- POST /v1/sprint11/invoices/file/raw (LOCAL saklama + opsiyonel remote upload)
- outputs/sprint11/... dosya + meta json kanıtı

---
Generated:
