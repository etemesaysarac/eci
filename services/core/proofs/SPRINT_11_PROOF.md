# ECI — Sprint 11 Proof Pack (Invoice / Label)
> Generated automatically (PowerShell-safe)

## 0) API — GET /health
~~~
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 11
ETag: W/"b-Ai2R8hgEarLmHKwesT1qcY913ys"
Date: Fri, 16 Jan 2026 14:57:52 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"ok":true}
~~~

## 1) API — GET /v1/connections
~~~json
[{"id":"cmk28anrb0000e6gwaprps4hn","type":"trendyol","name":"Trendyol PROD","status":"active","createdAt":"2026-01-06T06:48:43.461Z","updatedAt":"2026-01-06T06:48:43.461Z"},{"id":"cmjye68kf0000e67sr0xweur9","type":"trendyol","name":"Trendyol PROD","status":"active","createdAt":"2026-01-03T14:22:10.142Z","updatedAt":"2026-01-03T14:22:10.142Z"}]
~~~

## 2) API — GET /v1/sprint11/orders/sample (multi-connection + multi-status)
~~~json
{"ok":true,"pickedConnection":null,"connectionsTried":[{"id":"cmk28anrb0000e6gwaprps4hn","name":"Trendyol PROD","status":"active"}],"criteria":{"connectionId":"cmk28anrb0000e6gwaprps4hn","statusesTried":["(no status)","Picking","Invoiced","Shipped","Created","AtCollectionPoint","Awaiting","Delivered","Cancelled","UnDelivered","Returned","Repack","UnSupplied"],"carriersWanted":["TEX","ARAS"],"size":10,"page":0,"lookbackDays":90,"startDate":1760799472446,"endDate":1768575472446,"note":"If no sample is found, check attempts[] for which statuses were empty and whether seller has any orders in lookback window."},"attempts":[{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"(no status)","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"Picking","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"Invoiced","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"Shipped","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"Created","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"AtCollectionPoint","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"Awaiting","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"Delivered","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"Cancelled","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"UnDelivered","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"Returned","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"Repack","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null},{"connectionId":"cmk28anrb0000e6gwaprps4hn","connectionName":"Trendyol PROD","status":"UnSupplied","totalElements":0,"totalPages":0,"page":0,"size":0,"contentCount":0,"sample":null}],"forLabel":null,"forInvoice":null,"sample":null,"note":"PDF: commonlabel (etiket) akisi picking/invoiced gibi statuslerden sonra anlamli olur. Bu endpoint sadece ID kesfi + kanit icindir."}
~~~

## 2.1) Chosen connectionId
~~~
connectionId=cmk28anrb0000e6gwaprps4hn
~~~

## 2.3) Manual override IDs (env)
~~~
cargoTrackingNumber=7340029674646318
shipmentPackageId=3540843882
~~~

## 3) API — GET /v1/sprint11/seller/addresses
~~~json
{"ok":true,"connection":{"id":"cmk28anrb0000e6gwaprps4hn","name":"Trendyol PROD","status":"active"},"data":{"supplierAddresses":[{"id":224903,"addressType":"Shipment","country":"T├╝rkiye","city":"Konya","cityCode":42,"district":"Sel├ğuklu","districtId":692,"postCode":"42000","address":"Horozluhan mh. K├╝├ğ├╝kbezirci sk. No:15/1 42110 Sel├ğuklu/KONYA","stateCountyProvince":null,"buildingNumber":null,"isDefault":true,"shortAddress":null,"fullAddress":"Horozluhan mh. K├╝├ğ├╝kbezirci sk. No:15/1 42110 Sel├ğuklu/KONYA Sel├ğuklu 42000 Konya T├╝rkiye","isShipmentAddress":true,"isReturningAddress":false,"isInvoiceAddress":false},{"id":224904,"addressType":"Returning","country":"T├╝rkiye","city":"Konya","cityCode":42,"district":"Sel├ğuklu","districtId":692,"postCode":"42000","address":"Horozluhan mh. K├╝├ğ├╝kbezirci sk. No:15/1 42110 Sel├ğuklu/KONYA","stateCountyProvince":null,"buildingNumber":null,"isDefault":true,"shortAddress":null,"fullAddress":"Horozluhan mh. K├╝├ğ├╝kbezirci sk. No:15/1 42110 Sel├ğuklu/KONYA Sel├ğuklu 42000 Konya T├╝rkiye","isShipmentAddress":false,"isReturningAddress":true,"isInvoiceAddress":false},{"id":224902,"addressType":"Invoice","country":"T├╝rkiye","city":"Konya","cityCode":42,"district":"Sel├ğuklu","districtId":692,"postCode":"42000","address":"Mahalle/Semt:AKADEM─░ MAH. Cadde/Sokak:G├£RBULUT SK. S.├£.TEKNOLOJ─░ GEL─░┼ŞT─░RME B├ûLGES─░ KONYA TEKNOKENT No:67","stateCountyProvince":null,"buildingNumber":null,"isDefault":true,"shortAddress":null,"fullAddress":"Mahalle/Semt:AKADEM─░ MAH. Cadde/Sokak:G├£RBULUT SK. S.├£.TEKNOLOJ─░ GEL─░┼ŞT─░RME B├ûLGES─░ KONYA TEKNOKENT No:67 Sel├ğuklu 42000 Konya T├╝rkiye","isShipmentAddress":false,"isReturningAddress":false,"isInvoiceAddress":true}],"defaultShipmentAddress":{"id":224903,"addressType":"Shipment","country":"T├╝rkiye","city":"Konya","cityCode":42,"district":"Sel├ğuklu","districtId":692,"postCode":"42000","address":"Horozluhan mh. K├╝├ğ├╝kbezirci sk. No:15/1 42110 Sel├ğuklu/KONYA","stateCountyProvince":null,"buildingNumber":null,"isDefault":true,"shortAddress":null,"fullAddress":"Horozluhan mh. K├╝├ğ├╝kbezirci sk. No:15/1 42110 Sel├ğuklu/KONYA Sel├ğuklu 42000 Konya T├╝rkiye","isShipmentAddress":true,"isReturningAddress":false,"isInvoiceAddress":false},"defaultInvoiceAddress":{"id":224902,"addressType":"Invoice","country":"T├╝rkiye","city":"Konya","cityCode":42,"district":"Sel├ğuklu","districtId":692,"postCode":"42000","address":"Mahalle/Semt:AKADEM─░ MAH. Cadde/Sokak:G├£RBULUT SK. S.├£.TEKNOLOJ─░ GEL─░┼ŞT─░RME B├ûLGES─░ KONYA TEKNOKENT No:67","stateCountyProvince":null,"buildingNumber":null,"isDefault":true,"shortAddress":null,"fullAddress":"Mahalle/Semt:AKADEM─░ MAH. Cadde/Sokak:G├£RBULUT SK. S.├£.TEKNOLOJ─░ GEL─░┼ŞT─░RME B├ûLGES─░ KONYA TEKNOKENT No:67 Sel├ğuklu 42000 Konya T├╝rkiye","isShipmentAddress":false,"isReturningAddress":false,"isInvoiceAddress":true},"defaultReturningAddress":{"present":true}}}
~~~

## 4) API — GET /v1/sprint11/labels/common/:cargoTrackingNumber
~~~json
{"error":"internal_error","message":"Trendyol GET https://apigw.trendyol.com/integration/sellers/142312/commonlabel/7340029674646318 failed (556) :: {\"keys\":[\"message\"]}"}
~~~

## 4.1) API — GET /v1/sprint11/labels/common/:cargoTrackingNumber/download
~~~
HTTP/1.1 500 Internal Server Error
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 175
ETag: W/"af-chi7RNdY9pEI8ojmAZNCutnSD7g"
Date: Fri, 16 Jan 2026 14:57:53 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":"internal_error","message":"Trendyol GET https://apigw.trendyol.com/integration/sellers/142312/commonlabel/7340029674646318 failed (556) :: {\"keys\":[\"message\"]}"}
~~~

## 4.2) API — POST /v1/sprint11/labels/common/create (dryRun=1)
~~~json
{"ok":true,"dryRun":true,"wouldCall":"createCommonLabel","cargoTrackingNumber":"7340029674646318","payload":{"format":"ZPL"}}
~~~

## 5.A0) API — POST /v1/sprint11/invoices/file/publish (dryRun=0)
~~~json
{"ok":true,"stored":{"savedAt":"2026-01-16T14:57:53.869Z","connectionId":"cmk28anrb0000e6gwaprps4hn","shipmentPackageId":3540843882,"invoiceDateTime":1768575473841,"invoiceNumber":"ECI-3540843882","contentType":"application/pdf","bytes":478,"sha256":"7f3875d9bd5206dd592bbd495a391846e3d22578cfbb64704cc03f5cfa5d34f7","file":"outputs/sprint11/invoices/cmk28anrb0000e6gwaprps4hn/3540843882/invoice_3540843882_2026-01-16T14-57-53-869Z_ECI-3540843882.pdf"},"invoiceLink":"https://eci.goeasyso.com/v1/sprint11/public/invoices/cmk28anrb0000e6gwaprps4hn/3540843882/invoice_3540843882_2026-01-16T14-57-53-869Z_ECI-3540843882.pdf"}
~~~

## 5.A) API — POST /v1/sprint11/invoices/file/raw (dryRun=1)
~~~json
{"ok":true,"dryRun":true,"stored":{"savedAt":"2026-01-16T14:57:53.935Z","connectionId":"cmk28anrb0000e6gwaprps4hn","shipmentPackageId":3540843882,"invoiceDateTime":1768575473841,"invoiceNumber":"ECI-3540843882","contentType":"application/pdf","bytes":478,"sha256":"7f3875d9bd5206dd592bbd495a391846e3d22578cfbb64704cc03f5cfa5d34f7","file":"outputs/sprint11/invoices/cmk28anrb0000e6gwaprps4hn/3540843882/invoice_3540843882_2026-01-16T14-57-53-934Z.pdf"},"wouldCall":"sellerInvoiceFile"}
~~~

## 5) API — POST /v1/sprint11/invoices/link (dryRun=1)
~~~json
{"ok":true,"dryRun":true,"wouldCall":"sendInvoiceLink","body":{"invoiceLink":"https://eci.goeasyso.com/v1/sprint11/public/invoices/cmk28anrb0000e6gwaprps4hn/3540843882/invoice_3540843882_2026-01-16T14-57-53-869Z_ECI-3540843882.pdf","shipmentPackageId":3540843882,"invoiceDateTime":1768575473841,"invoiceNumber":"ECI-3540843882"}}
~~~

## 5.1) Invoice link delete
customerId bulunamadı. Delete adımı atlandı (sendInvoiceLink için customerId zorunlu değil).

---
Generated: 2026-01-16T17:57:54.0833274+03:00
