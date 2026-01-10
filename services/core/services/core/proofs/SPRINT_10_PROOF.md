
## 10.0 GO/NO-GO
### docker ps
### API health
`json
{"ok":true}
### Connection status
`json
{"connection":{"id":"cmk28anrb0000e6gwaprps4hn","type":"trendyol","name":"Trendyol PROD","status":"active","createdAt":"2026-01-06T06:48:43.461Z","updatedAt":"2026-01-06T06:48:43.461Z"},"state":{"lastAttemptAt":null,"lastSuccessAt":"2026-01-06T17:52:42.039Z","lastStatus":"IDLE","lastJobId":null,"lastError":null,"updatedAt":"2026-01-06T18:24:44.741Z"},"lastJob":{"id":"cmk8dq42l0001e6l8vvwa26ob","type":"TRENDYOL_PUSH_PRICE_STOCK","status":"success","startedAt":"2026-01-10T14:07:19.595Z","finishedAt":"2026-01-10T14:07:19.844Z","summary":{"dryRun":false,"bodyHash":"c4cfde00fea1a053069a38cab95b0b287fc67889e7804a4bf179807fa4005eec","response":{"batchRequestId":"acefc97c-ee2d-11f0-b92f-62396210b889-1768068439"},"itemCount":1,"durationMs":221,"writeEnabled":true,"originalCount":1,"batchRequestId":"acefc97c-ee2d-11f0-b92f-62396210b889-1768068439","coalescedCount":1},"error":null,"createdAt":"2026-01-10T14:07:19.581Z"}}
## 10.1 Smoke Test: push + poll
### Request payload
`json
{"items":[{"barcode":"8608802530385","quantity":null,"salePrice":191.93,"currencyType":"TRY","listPrice":331.96}],"connectionId":"cmk28anrb0000e6gwaprps4hn"}
`json
{"error":"internal_error","message":"Expected property name or '}' in JSON at position 1 (line 1 column 2)"}
### DB: Job summary (batchRequestId)
BATCH=
`json
{"error":"not_found"}
### Push #2 (same payload)
`json
{"error":"internal_error","message":"Expected property name or '}' in JSON at position 1 (line 1 column 2)"}
