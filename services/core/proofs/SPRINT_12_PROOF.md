# ECI - Sprint 12 (Claims / Iade) - PROOF (DEV/MOCK)

GeneratedAt (UTC): 2026-01-21 09:04:22
Base URL: http://127.0.0.1:3001

> Note: This run generates DEV/MOCK proofs (no real Trendyol claim exists in the test account).

## 1) Health
```json
{"ok":true}
```

## 2) Connections
```json
[{"id":"cmk28anrb0000e6gwaprps4hn","type":"trendyol","name":"Trendyol PROD","status":"active","createdAt":"2026-01-06T06:48:43.461Z","updatedAt":"2026-01-06T06:48:43.461Z"},{"id":"cmjye68kf0000e67sr0xweur9","type":"trendyol","name":"Trendyol PROD","status":"active","createdAt":"2026-01-03T14:22:10.142Z","updatedAt":"2026-01-03T14:22:10.142Z"}]
```

Selected connectionId: cmk28anrb0000e6gwaprps4hn

## 3) DEV seed (mock claims)
```json
{"connectionId":"cmk28anrb0000e6gwaprps4hn","seededClaims":2,"seeded":[{"claimId":"MOCK-CL-1768986262689-3912ac65-1","items":[{"claimItemId":"MOCK-CI-8236eaf9-4fe-1","itemStatus":"WaitingInAction"}]},{"claimId":"MOCK-CL-1768986262689-920c9619-2","items":[{"claimItemId":"MOCK-CI-e7be0e74-c37-1","itemStatus":"WaitingInAction"}]}]}
```

Resolved IDs: claimA=MOCK-CL-1768986262689-3912ac65-1 itemA=MOCK-CI-8236eaf9-4fe-1
Resolved IDs: claimB=MOCK-CL-1768986262689-920c9619-2 itemB=MOCK-CI-e7be0e74-c37-1

## 4) Read API
### GET /v1/claims/stats
```json
{"connectionId":"cmk28anrb0000e6gwaprps4hn","claims":{"total":17,"byStatus":{"WaitingFraudCheck":3,"WaitingInAction":14}},"items":{"total":20,"byStatus":{"Created":3,"IssueCreated":3,"WaitingFraudCheck":3,"WaitingInAction":11}},"updatedAt":"2026-01-21T09:04:22.897Z"}
```

### GET /v1/claims (list)
```json
{"page":0,"pageSize":20,"items":[{"id":"cmknsqw1g0009e68cklc4lpra","claimId":"MOCK-CL-1768986262689-920c9619-2","status":"WaitingInAction","orderNumber":"MOCK-ORDER-2","claimDate":"2026-01-21T09:04:22.689Z","lastModifiedAt":"2026-01-21T09:04:22.689Z","updatedAt":"2026-01-21T09:04:22.708Z","itemCount":1},{"id":"cmknsqw140001e68ca44fonvg","claimId":"MOCK-CL-1768986262689-3912ac65-1","status":"WaitingInAction","orderNumber":"MOCK-ORDER-1","claimDate":"2026-01-21T09:04:22.689Z","lastModifiedAt":"2026-01-21T09:04:22.689Z","updatedAt":"2026-01-21T09:04:22.696Z","itemCount":1},{"id":"cmknsqcnn000pe6jkb5eoy27j","claimId":"MOCK-CL-1768986237586-7393a9dd-1","status":"WaitingFraudCheck","orderNumber":"MOCK-ORDER-1","claimDate":"2026-01-21T09:03:57.586Z","lastModifiedAt":"2026-01-21T09:03:58.832Z","updatedAt":"2026-01-21T09:03:58.832Z","itemCount":1},{"id":"cmknsqcnx000xe6jk6wcxs2mi","claimId":"MOCK-CL-1768986237586-01811c2f-2","status":"WaitingInAction","orderNumber":"MOCK-ORDER-2","claimDate":"2026-01-21T09:03:57.586Z","lastModifiedAt":"2026-01-21T09:03:57.586Z","updatedAt":"2026-01-21T09:03:57.597Z","itemCount":1},{"id":"cmkns6hhk0001e6jk63s8bbi6","claimId":"MOCK-CL-1768985310724-559d5b5b-1","status":"WaitingFraudCheck","orderNumber":"MOCK-ORDER-1","claimDate":"2026-01-21T08:48:30.724Z","lastModifiedAt":"2026-01-21T08:48:32.123Z","updatedAt":"2026-01-21T08:48:32.123Z","itemCount":1},{"id":"cmkns6hhx0009e6jk09qznoy7","claimId":"MOCK-CL-1768985310724-31049099-2","status":"WaitingInAction","orderNumber":"MOCK-ORDER-2","claimDate":"2026-01-21T08:48:30.724Z","lastModifiedAt":"2026-01-21T08:48:30.724Z","updatedAt":"2026-01-21T08:48:30.741Z","itemCount":1},{"id":"cmknr7xem0001e67w1w22cz5g","claimId":"MOCK-CL-1768983698391-c7858c28-1","status":"WaitingFraudCheck","orderNumber":"MOCK-ORDER-1","claimDate":"2026-01-21T08:21:38.391Z","lastModifiedAt":"2026-01-21T08:21:39.306Z","updatedAt":"2026-01-21T08:21:39.306Z","itemCount":1},{"id":"cmknr7xey0009e67w9dqfa63b","claimId":"MOCK-CL-1768983698391-e50a8b3a-2","status":"WaitingInAction","orderNumber":"MOCK-ORDER-2","claimDate":"2026-01-21T08:21:38.391Z","lastModifiedAt":"2026-01-21T08:21:38.391Z","updatedAt":"2026-01-21T08:21:38.410Z","itemCount":1},{"id":"cmknpyvtt0009e6ng2mg62dbd","claimId":"MOCK-CL-1768981596814-539300d3-2","status":"WaitingInAction","orderNumber":"MOCK-ORDER-2","claimDate":"2026-01-21T07:46:36.814Z","lastModifiedAt":"2026-01-21T07:46:36.814Z","updatedAt":"2026-01-21T07:46:36.833Z","itemCount":1},{"id":"cmknpyvtf0001e6ngyhoefym1","claimId":"MOCK-CL-1768981596814-8cebbd32-1","status":"WaitingInAction","orderNumber":"MOCK-ORDER-1","claimDate":"2026-01-21T07:46:36.814Z","lastModifiedAt":"2026-01-21T07:46:36.814Z","updatedAt":"2026-01-21T07:46:36.819Z","itemCount":1},{"id":"cmknpdkby0009e6tgzbn6arwi","claimId":"MOCK-CL-1768980602141-64961272-2","status":"WaitingInAction","orderNumber":"MOCK-ORDER-2","claimDate":"2026-01-21T07:30:02.141Z","lastModifiedAt":"2026-01-21T07:30:02.141Z","updatedAt":"2026-01-21T07:30:02.158Z","itemCount":1},{"id":"cmknpdkbl0001e6tg2urazf8x","claimId":"MOCK-CL-1768980602141-d37a1d9c-1","status":"WaitingInAction","orderNumber":"MOCK-ORDER-1","claimDate":"2026-01-21T07:30:02.141Z","lastModifiedAt":"2026-01-21T07:30:02.141Z","updatedAt":"2026-01-21T07:30:02.145Z","itemCount":1},{"id":"cmknnmqzh000le6xotg7jo61t","claimId":"MOCK-CL-1768977671439-b7914517-2","status":"WaitingInAction","orderNumber":"MOCK-ORDER-2","claimDate":"2026-01-21T06:41:11.439Z","lastModifiedAt":"2026-01-21T06:41:11.439Z","updatedAt":"2026-01-21T06:41:11.453Z","itemCount":1},{"id":"cmknnmqz6000de6xo5p2swofc","claimId":"MOCK-CL-1768977671439-857cb020-1","status":"WaitingInAction","orderNumber":"MOCK-ORDER-1","claimDate":"2026-01-21T06:41:11.439Z","lastModifiedAt":"2026-01-21T06:41:11.439Z","updatedAt":"2026-01-21T06:41:11.443Z","itemCount":1},{"id":"cmknn7mi10001e6xo2naimfzc","claimId":"MOCK-CL-1768976965797-10ad5e40-1","status":"WaitingInAction","orderNumber":"MOCK-ORDER-1","claimDate":"2026-01-21T06:29:25.797Z","lastModifiedAt":"2026-01-21T06:29:25.797Z","updatedAt":"2026-01-21T06:29:25.801Z","itemCount":2},{"id":"cmknmdzyq0001e6pcofb0guqs","claimId":"MOCK-CL-1768975583567-ba4d8552-1","status":"WaitingInAction","orderNumber":"MOCK-ORDER-1","claimDate":"2026-01-21T06:06:23.567Z","lastModifiedAt":"2026-01-21T06:06:23.567Z","updatedAt":"2026-01-21T06:06:23.570Z","itemCount":2},{"id":"cmkn3t67x0001e6aw9do68zse","claimId":"MOCK-CL-1768944378808-bd74c648-1","status":"WaitingInAction","orderNumber":"MOCK-ORDER-1","claimDate":"2026-01-20T21:26:18.808Z","lastModifiedAt":"2026-01-20T21:26:18.808Z","updatedAt":"2026-01-20T21:26:18.813Z","itemCount":2}]}
```

### GET /v1/claims/MOCK-CL-1768986262689-3912ac65-1 (detail)
```json
{"error":"not_found"}
```

### GET /v1/claims/MOCK-CL-1768986262689-920c9619-2 (detail)
```json
{"error":"not_found"}
```

### GET /v1/claims/cmknsqw140001e68ca44fonvg (detail by dbId)
```json
{"error":"not_found"}
```

### GET /v1/claims/cmknsqw1g0009e68cklc4lpra (detail by dbId)
```json
{"error":"not_found"}
```

### GET /v1/claims/items (list)
```json
{"page":0,"pageSize":50,"total":20,"items":[{"claimId":"MOCK-CL-1768986262689-920c9619-2","claimItemId":"MOCK-CI-e7be0e74-c37-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingInAction","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T09:04:22.710Z","updatedAt":"2026-01-21T09:04:22.710Z"},{"claimId":"MOCK-CL-1768986262689-3912ac65-1","claimItemId":"MOCK-CI-8236eaf9-4fe-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingInAction","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T09:04:22.700Z","updatedAt":"2026-01-21T09:04:22.700Z"},{"claimId":"MOCK-CL-1768986237586-01811c2f-2","claimItemId":"MOCK-CI-53d31212-83f-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"IssueCreated","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T09:03:57.598Z","updatedAt":"2026-01-21T09:03:58.943Z"},{"claimId":"MOCK-CL-1768986237586-7393a9dd-1","claimItemId":"MOCK-CI-12f91aa4-393-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingFraudCheck","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T09:03:57.591Z","updatedAt":"2026-01-21T09:03:58.832Z"},{"claimId":"MOCK-CL-1768985310724-31049099-2","claimItemId":"MOCK-CI-1ead9c50-9b6-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"IssueCreated","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T08:48:30.743Z","updatedAt":"2026-01-21T08:48:32.231Z"},{"claimId":"MOCK-CL-1768985310724-559d5b5b-1","claimItemId":"MOCK-CI-1306423d-399-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingFraudCheck","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T08:48:30.732Z","updatedAt":"2026-01-21T08:48:32.123Z"},{"claimId":"MOCK-CL-1768983698391-e50a8b3a-2","claimItemId":"MOCK-CI-e71a957a-84b-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"IssueCreated","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T08:21:38.412Z","updatedAt":"2026-01-21T08:21:39.397Z"},{"claimId":"MOCK-CL-1768983698391-c7858c28-1","claimItemId":"MOCK-CI-042e3f12-d0a-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingFraudCheck","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T08:21:38.401Z","updatedAt":"2026-01-21T08:21:39.306Z"},{"claimId":"MOCK-CL-1768981596814-539300d3-2","claimItemId":"MOCK-CI-13e75705-dce-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingInAction","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T07:46:36.835Z","updatedAt":"2026-01-21T07:46:36.835Z"},{"claimId":"MOCK-CL-1768981596814-8cebbd32-1","claimItemId":"MOCK-CI-a3b2296d-5b6-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingInAction","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T07:46:36.823Z","updatedAt":"2026-01-21T07:46:36.823Z"},{"claimId":"MOCK-CL-1768980602141-64961272-2","claimItemId":"MOCK-CI-97d3ceed-4a9-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingInAction","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T07:30:02.160Z","updatedAt":"2026-01-21T07:30:02.160Z"},{"claimId":"MOCK-CL-1768980602141-d37a1d9c-1","claimItemId":"MOCK-CI-af8f48a6-b65-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingInAction","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T07:30:02.149Z","updatedAt":"2026-01-21T07:30:02.149Z"},{"claimId":"MOCK-CL-1768977671439-b7914517-2","claimItemId":"MOCK-CI-ac85b455-9d0-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingInAction","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T06:41:11.455Z","updatedAt":"2026-01-21T06:41:11.455Z"},{"claimId":"MOCK-CL-1768977671439-857cb020-1","claimItemId":"MOCK-CI-6c07a32b-5cb-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingInAction","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T06:41:11.446Z","updatedAt":"2026-01-21T06:41:11.446Z"},{"claimId":"MOCK-CL-1768976965797-10ad5e40-1","claimItemId":"MOCK-CI-62131147-38c-2","sku":"MOCK-SKU-2","barcode":"MOCK-BARCODE-2","quantity":1,"itemStatus":"Created","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T06:29:25.812Z","updatedAt":"2026-01-21T06:29:25.812Z"},{"claimId":"MOCK-CL-1768976965797-10ad5e40-1","claimItemId":"MOCK-CI-b7bdb4ad-00c-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingInAction","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T06:29:25.804Z","updatedAt":"2026-01-21T06:29:25.804Z"},{"claimId":"MOCK-CL-1768975583567-ba4d8552-1","claimItemId":"MOCK-CI-2d5206ae-07b-2","sku":"MOCK-SKU-2","barcode":"MOCK-BARCODE-2","quantity":1,"itemStatus":"Created","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T06:06:23.583Z","updatedAt":"2026-01-21T06:06:23.583Z"},{"claimId":"MOCK-CL-1768975583567-ba4d8552-1","claimItemId":"MOCK-CI-6a3591f4-734-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingInAction","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-21T06:06:23.575Z","updatedAt":"2026-01-21T06:06:23.575Z"},{"claimId":"MOCK-CL-1768944378808-bd74c648-1","claimItemId":"MOCK-CI-9520d4e7-e3e-2","sku":"MOCK-SKU-2","barcode":"MOCK-BARCODE-2","quantity":1,"itemStatus":"Created","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-20T21:26:18.832Z","updatedAt":"2026-01-20T21:26:18.832Z"},{"claimId":"MOCK-CL-1768944378808-bd74c648-1","claimItemId":"MOCK-CI-1aa121a1-745-1","sku":"MOCK-SKU-1","barcode":"MOCK-BARCODE-1","quantity":1,"itemStatus":"WaitingInAction","reasonCode":"MOCK","reasonName":"Mock seeded reason","createdAt":"2026-01-20T21:26:18.821Z","updatedAt":"2026-01-20T21:26:18.821Z"}]}
```

### GET /v1/claims/items/MOCK-CI-8236eaf9-4fe-1/audits (before)
```json
{"claimItemId":"MOCK-CI-8236eaf9-4fe-1","audits":[{"previousStatus":null,"newStatus":"Created","executorApp":"MockSellerIntegrationApi","executorUser":"mock","date":"2026-01-21T09:04:22.690Z","raw":{"mock":true,"note":"Seed audit (local only)"}},{"previousStatus":"Created","newStatus":"WaitingInAction","executorApp":"MockSellerIntegrationApi","executorUser":"mock","date":"2026-01-21T09:04:22.691Z","raw":{"mock":true,"note":"Seed audit (local only)"}}]}
```

### GET /v1/claims/items/MOCK-CI-e7be0e74-c37-1/audits (before)
```json
{"claimItemId":"MOCK-CI-e7be0e74-c37-1","audits":[{"previousStatus":null,"newStatus":"Created","executorApp":"MockSellerIntegrationApi","executorUser":"mock","date":"2026-01-21T09:04:23.690Z","raw":{"mock":true,"note":"Seed audit (local only)"}},{"previousStatus":"Created","newStatus":"WaitingInAction","executorApp":"MockSellerIntegrationApi","executorUser":"mock","date":"2026-01-21T09:04:23.691Z","raw":{"mock":true,"note":"Seed audit (local only)"}}]}
```

### GET /v1/claims/issue-reasons (dictionary)
```json
{"source":"trendyol","reasons":[{"id":251,"name":"Müşteriden gelen ürün defolu/zarar görmüş"},{"id":401,"name":"Müşteriden gelen ürün adedi eksik"},{"id":201,"name":"Müşteriden gelen ürün yanlış"},{"id":51,"name":"Müşteriden gelen ürün kullanılmış"},{"id":151,"name":"Müşteriden gelen ürünün parçası/aksesuarı eksik"},{"id":1751,"name":"Gönderdiğim ürün kusurlu değil"},{"id":1701,"name":"Gönderdiğim ürün yanlış değil"},{"id":1651,"name":"Müşterinin yolladığı iade paketi elime ulaşmadı"},{"id":451,"name":"Müşteriden gelen ürünü analize göndereceğim"},{"id":1801,"name":"Üretim kaynaklı sorun bulunmadı"},{"id":1851,"name":"Ürün değişimi yapıldı"},{"id":1901,"name":"Ürün tamiratı gerçekleştirildi"},{"id":1951,"name":"Müşteri Kurumsal İade Faturasını Kesmedi"},{"id":2001,"name":"Müşteri Kurumsal İade Faturasını Hatalı Kesti"},{"id":2051,"name":"Hijyenik risk barındıran ürün paketi açılmış"},{"id":2101,"name":"Sipariş sorusundan gelen değişim talebi (müşterinin talebi yoksa kullanılmamalı)"},{"id":2151,"name":"Ürünün teknik servise gönderilmesi için müşteriye faturayı göndereceğim"},{"id":2201,"name":"Gönderdiğim ürün eksik değil"}]}
```

## 5) Commands (DEV/MOCK)
### POST /v1/claims/MOCK-CL-1768986262689-3912ac65-1/approve
```json
{"mode":"mock","claimId":"MOCK-CL-1768986262689-3912ac65-1","connectionId":"cmk28anrb0000e6gwaprps4hn","affected":1,"claimCommandId":"cmknsqx2d000je68cg05sjj91"}
```

### POST /v1/claims/MOCK-CL-1768986262689-920c9619-2/reject
```json
{"mode":"mock","claimId":"MOCK-CL-1768986262689-920c9619-2","connectionId":"cmk28anrb0000e6gwaprps4hn","affected":1,"claimCommandId":"cmknsqx58000ne68cd9qf25wn"}
```

### GET /v1/claims/items/MOCK-CI-8236eaf9-4fe-1/audits (after)
```json
{"claimItemId":"MOCK-CI-8236eaf9-4fe-1","audits":[{"previousStatus":null,"newStatus":"Created","executorApp":"MockSellerIntegrationApi","executorUser":"mock","date":"2026-01-21T09:04:22.690Z","raw":{"mock":true,"note":"Seed audit (local only)"}},{"previousStatus":"Created","newStatus":"WaitingInAction","executorApp":"MockSellerIntegrationApi","executorUser":"mock","date":"2026-01-21T09:04:22.691Z","raw":{"mock":true,"note":"Seed audit (local only)"}},{"previousStatus":"WaitingInAction","newStatus":"WaitingFraudCheck","executorApp":"MockEci","executorUser":"eci-dev","date":"2026-01-21T09:04:24.023Z","raw":{"mock":true,"note":"Local approve simulation (no Trendyol call)"}}]}
```

### GET /v1/claims/items/MOCK-CI-e7be0e74-c37-1/audits (after)
```json
{"claimItemId":"MOCK-CI-e7be0e74-c37-1","audits":[{"previousStatus":null,"newStatus":"Created","executorApp":"MockSellerIntegrationApi","executorUser":"mock","date":"2026-01-21T09:04:23.690Z","raw":{"mock":true,"note":"Seed audit (local only)"}},{"previousStatus":"Created","newStatus":"WaitingInAction","executorApp":"MockSellerIntegrationApi","executorUser":"mock","date":"2026-01-21T09:04:23.691Z","raw":{"mock":true,"note":"Seed audit (local only)"}},{"previousStatus":"WaitingInAction","newStatus":"IssueCreated","executorApp":"MockEci","executorUser":"eci-dev","date":"2026-01-21T09:04:24.132Z","raw":{"mock":true,"note":"Local reject simulation (no Trendyol call)","claimIssueReasonId":1651}}]}
```

## 6) DB counts (via API)
```json
{"connectionId":"cmk28anrb0000e6gwaprps4hn","claimCount":17,"claimItemCount":20,"claimAuditCount":45,"claimCommandCount":8}
```

## 7) Rate limit note
- In DEV/MOCK mode: no external Trendyol calls are made.
- Real Trendyol limits (from Trendyol.pdf): list/audit 1000 req/min, approve/reject/create 5 req/min.

## 8) Closing
- DEV/MOCK proof generated. Real Trendyol audit (executorApp=SellerIntegrationApi) requires real claim flow.

