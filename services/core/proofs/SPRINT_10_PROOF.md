# ECI — Sprint 10 Proof Pack
> Generated automatically (PowerShell-safe)

## 0) Infra — docker ps
~~~
CONTAINER ID   IMAGE         COMMAND                  CREATED       STATUS        PORTS                                         NAMES
442ed99f0c16   postgres:16   "docker-entrypoint.sÔÇĞ"   2 weeks ago   Up 12 hours   0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp   infra-postgres-1
f79350252547   redis:7       "docker-entrypoint.sÔÇĞ"   2 weeks ago   Up 12 hours   0.0.0.0:6379->6379/tcp, [::]:6379->6379/tcp   infra-redis-1
~~~

## 1) API — GET /health
~~~
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 11
ETag: W/"b-Ai2R8hgEarLmHKwesT1qcY913ys"
Date: Tue, 13 Jan 2026 16:54:42 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"ok":true}
~~~

## 2) API — GET /v1/connections
~~~json
[{"id":"cmk28anrb0000e6gwaprps4hn","type":"trendyol","name":"Trendyol PROD","status":"active","createdAt":"2026-01-06T06:48:43.461Z","updatedAt":"2026-01-06T06:48:43.461Z"},{"id":"cmjye68kf0000e67sr0xweur9","type":"trendyol","name":"Trendyol PROD","status":"active","createdAt":"2026-01-03T14:22:10.142Z","updatedAt":"2026-01-03T14:22:10.142Z"}]
~~~

## 2.1) Picked connectionId
~~~
connectionId=cmk28anrb0000e6gwaprps4hn
~~~

## 3) API — GET /v1/connections/:id/status
~~~json
{"connection":{"id":"cmk28anrb0000e6gwaprps4hn","type":"trendyol","name":"Trendyol PROD","status":"active","createdAt":"2026-01-06T06:48:43.461Z","updatedAt":"2026-01-06T06:48:43.461Z"},"state":{"lastAttemptAt":null,"lastSuccessAt":"2026-01-06T17:52:42.039Z","lastStatus":"IDLE","lastJobId":null,"lastError":null,"updatedAt":"2026-01-06T18:24:44.741Z"},"lastJob":{"id":"cmkcqdwhc0005e6m8fam07kyh","type":"TRENDYOL_PUSH_PRICE_STOCK","status":"success","startedAt":"2026-01-13T15:12:49.603Z","finishedAt":"2026-01-13T15:12:49.609Z","summary":{"note":"dryRun=1 ÔåÆ remote call skipped","dryRun":true,"bodyHash":"14017ad618dcd16f98a0287d71b0a770c25afbc811563ed49e0470c69e0547ff","itemCount":1,"durationMs":2,"writeEnabled":false,"originalCount":1001,"coalescedCount":1001,"forceWriteParam":false,"writeEnabledEnv":false,"forceWriteAllowed":true,"forceWriteEffective":false},"error":null,"createdAt":"2026-01-13T15:12:49.584Z"}}
~~~

## 3.1) DB — Ensure inventory_confirmed_state
~~~
CREATE TABLE
CREATE INDEX
CREATE INDEX
NOTICE:  relation "inventory_confirmed_state" already exists, skipping
NOTICE:  relation "inventory_confirmed_state_connectionId_idx" already exists, skipping
NOTICE:  relation "inventory_confirmed_state_barcode_idx" already exists, skipping
~~~

## 4) DB — Picked ProductVariant row
~~~
8696947006698|0|0|0
~~~

## 5) Payload (file)
~~~json
path=C:\Users\Admin\AppData\Local\Temp\eci_inventory_push.json
{
  "items": [
    {
      "listPrice": 0.0,
      "quantity": 0,
      "currencyType": "TRY",
      "barcode": "8696947006698",
      "salePrice": 0.0
    }
  ],
  "connectionId": "cmk28anrb0000e6gwaprps4hn"
}
~~~

## 6) Push #1 — POST /v1/inventory/push
~~~
HTTP/1.1 202 Accepted
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 537
ETag: W/"219-Co+UrCdpiweBHlZ12rBOvOs9MFE"
Date: Tue, 13 Jan 2026 16:54:43 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"ok":true,"dryRun":false,"force":true,"forceWrite":true,"forceWriteAllowed":true,"originalCount":1,"coalescedCount":1,"changedCount":1,"skippedCount":0,"chunkSize":1000,"chunkCount":1,"enqueuedCount":1,"dedupCount":0,"dedupWindowMs":900000,"jobId":"cmkcu0y9b0001e61wpzl1s331","bodyHash":"f91eec6367fc243454b5b23d9082baa485b1f83a8345b0385cec1c0bc4397c75","dedup":false,"jobs":[{"chunkIndex":0,"itemCount":1,"bodyHash":"f91eec6367fc243454b5b23d9082baa485b1f83a8345b0385cec1c0bc4397c75","dedup":false,"jobId":"cmkcu0y9b0001e61wpzl1s331"}]}
~~~

## 6.1) jobId
~~~
cmkcu0y9b0001e61wpzl1s331
~~~

## 6.2) bodyHash
~~~
f91eec6367fc243454b5b23d9082baa485b1f83a8345b0385cec1c0bc4397c75
~~~

## 7) DB — Job status+summary (polled)
~~~
attempts=1
status=success
summary={"dryRun": false, "bodyHash": "f91eec6367fc243454b5b23d9082baa485b1f83a8345b0385cec1c0bc4397c75", "response": {"batchRequestId": "8eba1a20-f0a0-11f0-bea9-26fe36d0f6e4-1768337682"}, "itemCount": 1, "durationMs": 217, "writeEnabled": true, "originalCount": 1, "batchRequestId": "8eba1a20-f0a0-11f0-bea9-26fe36d0f6e4-1768337682", "coalescedCount": 1, "forceWriteParam": true, "writeEnabledEnv": false, "forceWriteAllowed": true, "forceWriteEffective": true}
~~~

## 7.1) batchRequestId
~~~
8eba1a20-f0a0-11f0-bea9-26fe36d0f6e4-1768337682
~~~

## 8) Poll — GET /v1/inventory/batch/:batchId (attempts=2)
~~~
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 581
ETag: W/"245-GxH6+KqiUgCeDXYx5P0e4vMcT6s"
Date: Tue, 13 Jan 2026 16:54:56 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"batchRequestId":"8eba1a20-f0a0-11f0-bea9-26fe36d0f6e4-1768337682","items":[{"requestItem":{"updateRequestDate":"2026-01-13T16:54:43.163+00:00","quantity":0,"salePrice":0,"barcode":"8696947006698","listPrice":0},"status":"SUCCESS","failureReasons":[]}],"creationDate":1768323283162,"lastModification":1768323283162,"sourceType":"API","itemCount":1,"failedItemCount":0,"batchRequestType":"ProductInventoryUpdate","notes":null,"objectKey":null,"_eci":{"confirmedUpserted":1,"note":"inventory_confirmed_state raw SQL fallback active (prisma client missing InventoryConfirmedState)"}}
~~~

## 8.0) Poll — status summary
~~~
SUCCESS:1
~~~

## 8.1) DB — inventory_confirmed_state row
~~~
8696947006698|0|0.0000|0.0000||8eba1a20-f0a0-11f0-bea9-26fe36d0f6e4-1768337682|2026-01-13 16:54:56.747+00
~~~

## 9) Push #2 (same-body) — dedup proof
~~~
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 535
ETag: W/"217-Do1pYvswL4jXC7wiZ+SKyJdGdbk"
Date: Tue, 13 Jan 2026 16:54:57 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"ok":true,"dryRun":false,"force":true,"forceWrite":true,"forceWriteAllowed":true,"originalCount":1,"coalescedCount":1,"changedCount":1,"skippedCount":0,"chunkSize":1000,"chunkCount":1,"enqueuedCount":0,"dedupCount":1,"dedupWindowMs":900000,"jobId":"cmkcu0y9b0001e61wpzl1s331","bodyHash":"f91eec6367fc243454b5b23d9082baa485b1f83a8345b0385cec1c0bc4397c75","dedup":true,"jobs":[{"chunkIndex":0,"itemCount":1,"bodyHash":"f91eec6367fc243454b5b23d9082baa485b1f83a8345b0385cec1c0bc4397c75","dedup":true,"jobId":"cmkcu0y9b0001e61wpzl1s331"}]}
~~~

## 9.1) Redis — dedup key
~~~
redis=infra-redis-1
key=eci:inv:dedup:cmk28anrb0000e6gwaprps4hn:f91eec6367fc243454b5b23d9082baa485b1f83a8345b0385cec1c0bc4397c75
GET=cmkcu0y9b0001e61wpzl1s331
TTL=886
~~~

## 10) Chunking payload (1001 items, dry-run)
~~~
path=C:\Users\Admin\AppData\Local\Temp\eci_inventory_chunk_1001.json
items=1001
~~~

## 10.1) Chunking — POST /v1/inventory/push?dryRun=1
~~~
HTTP/1.1 202 Accepted
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 581
ETag: W/"245-DZhr1ii950UudBSpsQbMDfVDHPY"
Date: Tue, 13 Jan 2026 16:54:57 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"ok":true,"dryRun":true,"force":false,"forceWrite":false,"forceWriteAllowed":true,"originalCount":1001,"coalescedCount":1001,"changedCount":1001,"skippedCount":0,"chunkSize":1000,"chunkCount":2,"enqueuedCount":2,"dedupCount":0,"dedupWindowMs":900000,"jobs":[{"chunkIndex":0,"itemCount":1000,"bodyHash":"9153a3cff5a9cdaab3a6460c20e97e1e492fa2e745865b4683936b57192b4d16","dedup":false,"jobId":"cmkcu18ur0003e61wq1l2kxnc"},{"chunkIndex":1,"itemCount":1,"bodyHash":"14017ad618dcd16f98a0287d71b0a770c25afbc811563ed49e0470c69e0547ff","dedup":false,"jobId":"cmkcu18v00005e61w8yolesp0"}]}
~~~

## 10.2) DB — Chunk job status+summary (jobId=cmkcu18ur0003e61wq1l2kxnc, attempts=1)
~~~
status=success
summary={"note": "dryRun=1 ÔåÆ remote call skipped", "dryRun": true, "bodyHash": "9153a3cff5a9cdaab3a6460c20e97e1e492fa2e745865b4683936b57192b4d16", "itemCount": 1000, "durationMs": 1, "writeEnabled": false, "originalCount": 1001, "coalescedCount": 1001, "forceWriteParam": false, "writeEnabledEnv": false, "forceWriteAllowed": true, "forceWriteEffective": false}
~~~

## 10.2) DB — Chunk job status+summary (jobId=cmkcu18v00005e61w8yolesp0, attempts=1)
~~~
status=success
summary={"note": "dryRun=1 ÔåÆ remote call skipped", "dryRun": true, "bodyHash": "14017ad618dcd16f98a0287d71b0a770c25afbc811563ed49e0470c69e0547ff", "itemCount": 1, "durationMs": 2, "writeEnabled": false, "originalCount": 1001, "coalescedCount": 1001, "forceWriteParam": false, "writeEnabledEnv": false, "forceWriteAllowed": true, "forceWriteEffective": false}
~~~

## 11) Worker excerpt (jobId context)
~~~
No lines found for jobId=cmkcu0y9b0001e61wpzl1s331 in C:\dev\eci\worker.log
~~~

## Done
- proof: C:\dev\eci\services\core\proofs\SPRINT_10_PROOF.md
- connectionId: cmk28anrb0000e6gwaprps4hn
- jobId: cmkcu0y9b0001e61wpzl1s331
- batchRequestId: 8eba1a20-f0a0-11f0-bea9-26fe36d0f6e4-1768337682

