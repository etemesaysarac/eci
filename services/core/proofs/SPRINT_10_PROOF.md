# ECI — Sprint 10 Proof Pack
> Generated automatically (PowerShell-safe)

## 0) Infra — docker ps
~~~
CONTAINER ID   IMAGE         COMMAND                  CREATED       STATUS       PORTS                                         NAMES
442ed99f0c16   postgres:16   "docker-entrypoint.sÔÇĞ"   2 weeks ago   Up 4 hours   0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp   infra-postgres-1
f79350252547   redis:7       "docker-entrypoint.sÔÇĞ"   2 weeks ago   Up 4 hours   0.0.0.0:6379->6379/tcp, [::]:6379->6379/tcp   infra-redis-1
~~~

## 1) API — GET /health
~~~json
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
{"connection":{"id":"cmk28anrb0000e6gwaprps4hn","type":"trendyol","name":"Trendyol PROD","status":"active","createdAt":"2026-01-06T06:48:43.461Z","updatedAt":"2026-01-06T06:48:43.461Z"},"state":{"lastAttemptAt":null,"lastSuccessAt":"2026-01-06T17:52:42.039Z","lastStatus":"IDLE","lastJobId":null,"lastError":null,"updatedAt":"2026-01-06T18:24:44.741Z"},"lastJob":{"id":"cmk8dq42l0001e6l8vvwa26ob","type":"TRENDYOL_PUSH_PRICE_STOCK","status":"success","startedAt":"2026-01-10T14:07:19.595Z","finishedAt":"2026-01-10T14:07:19.844Z","summary":{"dryRun":false,"bodyHash":"c4cfde00fea1a053069a38cab95b0b287fc67889e7804a4bf179807fa4005eec","response":{"batchRequestId":"acefc97c-ee2d-11f0-b92f-62396210b889-1768068439"},"itemCount":1,"durationMs":221,"writeEnabled":true,"originalCount":1,"batchRequestId":"acefc97c-ee2d-11f0-b92f-62396210b889-1768068439","coalescedCount":1},"error":null,"createdAt":"2026-01-10T14:07:19.581Z"}}
~~~


## 4) API — GET /v1/inventory/batch/acefc97c-ee2d-11f0-b92f-62396210b889-1768068439
~~~
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 453
ETag: W/"1c5-vERRonm7WoEBBuZ+lCAQXwyKi+A"
Date: Sat, 10 Jan 2026 15:39:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"batchRequestId":"acefc97c-ee2d-11f0-b92f-62396210b889-1768068439","items":[{"requestItem":{"updateRequestDate":"2026-01-10T14:07:19.700+00:00","quantity":3,"salePrice":191.93,"barcode":"8608802530385","listPrice":331.96},"status":"SUCCESS","failureReasons":[]}],"creationDate":1768054039699,"lastModification":1768054039699,"sourceType":"API","itemCount":1,"failedItemCount":0,"batchRequestType":"ProductInventoryUpdate","notes":null,"objectKey":null}
~~~

## 5) Redis — dedup key (15dk aynı body engeli)
~~~
~~~
