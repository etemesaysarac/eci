# ECI — Sprint 12 (Claims / İade) — PROOF (DEV/MOCK)

GeneratedAt (UTC): 01/21/2026 09:41:10.ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')

Base URL: http://127.0.0.1:3001

> Not: Bu proof **DEV/MOCK** akışı içindir. Test hesabında gerçek iade olmayacağı için Trendyol executorApp=SellerIntegrationApi kanıtı bu koşuda üretilemez. Kod akışı mock ile doğrulanmıştır.


## 0) Sprint 12 Hedef Kapsamı (özet)

- Read path: getClaims (SYNC) + DB upsert + API read (list/detail/items/audits)

- Command path: approve + reject(issue) + audit loglama (DEV/MOCK simülasyon)

- Kanıt: API cevapları + DB sayımları + audit kayıtları

- Rate limit notu: DEV/MOCK çağrıları Trendyol'a gitmez; gerçek claim yok.


## 1) Runtime / Infra Kanıtı

### 1.1 Docker ps
`	ext

CONTAINER ID   IMAGE         COMMAND                  CREATED        STATUS        PORTS                                         NAMES
aa45dc3dfc95   postgres:16   "docker-entrypoint.sÔÇĞ"   17 hours ago   Up 17 hours   0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp   infra-postgres-1
1b44c7fc7853   redis:7       "docker-entrypoint.sÔÇĞ"   17 hours ago   Up 17 hours   0.0.0.0:6379->6379/tcp, [::]:6379->6379/tcp   infra-redis-1

``n

## 2) Connection seçimi (API üzerinden otomatik)

### 2.1 GET /v1/connections
`json

[
    {
        "id":  "cmk28anrb0000e6gwaprps4hn",
        "type":  "trendyol",
        "name":  "Trendyol PROD",
        "status":  "active",
        "createdAt":  "2026-01-06T06:48:43.461Z",
        "updatedAt":  "2026-01-06T06:48:43.461Z"
    },
    {
        "id":  "cmjye68kf0000e67sr0xweur9",
        "type":  "trendyol",
        "name":  "Trendyol PROD",
        "status":  "active",
        "createdAt":  "2026-01-03T14:22:10.142Z",
        "updatedAt":  "2026-01-03T14:22:10.142Z"
    }
]

``n

Selected connectionId: **cmk28anrb0000e6gwaprps4hn**


## 3) DEV/MOCK Seed (sanal claim üretimi)

### 3.1 POST /v1/connections/:id/dev/seed-claims
`json

{
    "connectionId":  "cmk28anrb0000e6gwaprps4hn",
    "seededClaims":  2,
    "seeded":  [
                   {
                       "claimId":  "MOCK-CL-1768977671439-857cb020-1",
                       "items":  [
                                     {
                                         "claimItemId":  "MOCK-CI-6c07a32b-5cb-1",
                                         "itemStatus":  "WaitingInAction"
                                     }
                                 ]
                   },
                   {
                       "claimId":  "MOCK-CL-1768977671439-b7914517-2",
                       "items":  [
                                     {
                                         "claimItemId":  "MOCK-CI-ac85b455-9d0-1",
                                         "itemStatus":  "WaitingInAction"
                                     }
                                 ]
                   }
               ]
}

``n

Seeded/Selected:
- claimA=MOCK-CL-1768977671439-857cb020-1 (itemA=MOCK-CI-6c07a32b-5cb-1)
- claimB=MOCK-CL-1768977671439-b7914517-2 (itemB=MOCK-CI-ac85b455-9d0-1)


## 4) Read API Kanıtları

### 4.1 GET /v1/claims/stats
`json

{
    "connectionId":  "cmk28anrb0000e6gwaprps4hn",
    "claims":  {
                   "total":  5,
                   "byStatus":  {
                                    "WaitingInAction":  5
                                }
               },
    "items":  {
                  "total":  8,
                  "byStatus":  {
                                   "Created":  3,
                                   "WaitingInAction":  5
                               }
              },
    "updatedAt":  "2026-01-21T06:41:11.824Z"
}

``n
### 4.2 GET /v1/claims (list)
`json

{
    "page":  0,
    "pageSize":  20,
    "items":  [
                  {
                      "id":  "cmknnmqzh000le6xotg7jo61t",
                      "claimId":  "MOCK-CL-1768977671439-b7914517-2",
                      "status":  "WaitingInAction",
                      "orderNumber":  "MOCK-ORDER-2",
                      "claimDate":  "2026-01-21T06:41:11.439Z",
                      "lastModifiedAt":  "2026-01-21T06:41:11.439Z",
                      "updatedAt":  "2026-01-21T06:41:11.453Z",
                      "itemCount":  1
                  },
                  {
                      "id":  "cmknnmqz6000de6xo5p2swofc",
                      "claimId":  "MOCK-CL-1768977671439-857cb020-1",
                      "status":  "WaitingInAction",
                      "orderNumber":  "MOCK-ORDER-1",
                      "claimDate":  "2026-01-21T06:41:11.439Z",
                      "lastModifiedAt":  "2026-01-21T06:41:11.439Z",
                      "updatedAt":  "2026-01-21T06:41:11.443Z",
                      "itemCount":  1
                  },
                  {
                      "id":  "cmknn7mi10001e6xo2naimfzc",
                      "claimId":  "MOCK-CL-1768976965797-10ad5e40-1",
                      "status":  "WaitingInAction",
                      "orderNumber":  "MOCK-ORDER-1",
                      "claimDate":  "2026-01-21T06:29:25.797Z",
                      "lastModifiedAt":  "2026-01-21T06:29:25.797Z",
                      "updatedAt":  "2026-01-21T06:29:25.801Z",
                      "itemCount":  2
                  },
                  {
                      "id":  "cmknmdzyq0001e6pcofb0guqs",
                      "claimId":  "MOCK-CL-1768975583567-ba4d8552-1",
                      "status":  "WaitingInAction",
                      "orderNumber":  "MOCK-ORDER-1",
                      "claimDate":  "2026-01-21T06:06:23.567Z",
                      "lastModifiedAt":  "2026-01-21T06:06:23.567Z",
                      "updatedAt":  "2026-01-21T06:06:23.570Z",
                      "itemCount":  2
                  },
                  {
                      "id":  "cmkn3t67x0001e6aw9do68zse",
                      "claimId":  "MOCK-CL-1768944378808-bd74c648-1",
                      "status":  "WaitingInAction",
                      "orderNumber":  "MOCK-ORDER-1",
                      "claimDate":  "2026-01-20T21:26:18.808Z",
                      "lastModifiedAt":  "2026-01-20T21:26:18.808Z",
                      "updatedAt":  "2026-01-20T21:26:18.813Z",
                      "itemCount":  2
                  }
              ]
}

``n
### 4.3 GET /v1/claims/:claimId (detail)
#### claimA
`json


``n
#### claimB
`json


``n
### 4.4 GET /v1/claims/items (list)
`json

{
    "page":  0,
    "pageSize":  50,
    "total":  8,
    "items":  [
                  {
                      "claimId":  "MOCK-CL-1768977671439-b7914517-2",
                      "claimItemId":  "MOCK-CI-ac85b455-9d0-1",
                      "sku":  "MOCK-SKU-1",
                      "barcode":  "MOCK-BARCODE-1",
                      "quantity":  1,
                      "itemStatus":  "WaitingInAction",
                      "reasonCode":  "MOCK",
                      "reasonName":  "Mock seeded reason",
                      "createdAt":  "2026-01-21T06:41:11.455Z",
                      "updatedAt":  "2026-01-21T06:41:11.455Z"
                  },
                  {
                      "claimId":  "MOCK-CL-1768977671439-857cb020-1",
                      "claimItemId":  "MOCK-CI-6c07a32b-5cb-1",
                      "sku":  "MOCK-SKU-1",
                      "barcode":  "MOCK-BARCODE-1",
                      "quantity":  1,
                      "itemStatus":  "WaitingInAction",
                      "reasonCode":  "MOCK",
                      "reasonName":  "Mock seeded reason",
                      "createdAt":  "2026-01-21T06:41:11.446Z",
                      "updatedAt":  "2026-01-21T06:41:11.446Z"
                  },
                  {
                      "claimId":  "MOCK-CL-1768976965797-10ad5e40-1",
                      "claimItemId":  "MOCK-CI-62131147-38c-2",
                      "sku":  "MOCK-SKU-2",
                      "barcode":  "MOCK-BARCODE-2",
                      "quantity":  1,
                      "itemStatus":  "Created",
                      "reasonCode":  "MOCK",
                      "reasonName":  "Mock seeded reason",
                      "createdAt":  "2026-01-21T06:29:25.812Z",
                      "updatedAt":  "2026-01-21T06:29:25.812Z"
                  },
                  {
                      "claimId":  "MOCK-CL-1768976965797-10ad5e40-1",
                      "claimItemId":  "MOCK-CI-b7bdb4ad-00c-1",
                      "sku":  "MOCK-SKU-1",
                      "barcode":  "MOCK-BARCODE-1",
                      "quantity":  1,
                      "itemStatus":  "WaitingInAction",
                      "reasonCode":  "MOCK",
                      "reasonName":  "Mock seeded reason",
                      "createdAt":  "2026-01-21T06:29:25.804Z",
                      "updatedAt":  "2026-01-21T06:29:25.804Z"
                  },
                  {
                      "claimId":  "MOCK-CL-1768975583567-ba4d8552-1",
                      "claimItemId":  "MOCK-CI-2d5206ae-07b-2",
                      "sku":  "MOCK-SKU-2",
                      "barcode":  "MOCK-BARCODE-2",
                      "quantity":  1,
                      "itemStatus":  "Created",
                      "reasonCode":  "MOCK",
                      "reasonName":  "Mock seeded reason",
                      "createdAt":  "2026-01-21T06:06:23.583Z",
                      "updatedAt":  "2026-01-21T06:06:23.583Z"
                  },
                  {
                      "claimId":  "MOCK-CL-1768975583567-ba4d8552-1",
                      "claimItemId":  "MOCK-CI-6a3591f4-734-1",
                      "sku":  "MOCK-SKU-1",
                      "barcode":  "MOCK-BARCODE-1",
                      "quantity":  1,
                      "itemStatus":  "WaitingInAction",
                      "reasonCode":  "MOCK",
                      "reasonName":  "Mock seeded reason",
                      "createdAt":  "2026-01-21T06:06:23.575Z",
                      "updatedAt":  "2026-01-21T06:06:23.575Z"
                  },
                  {
                      "claimId":  "MOCK-CL-1768944378808-bd74c648-1",
                      "claimItemId":  "MOCK-CI-9520d4e7-e3e-2",
                      "sku":  "MOCK-SKU-2",
                      "barcode":  "MOCK-BARCODE-2",
                      "quantity":  1,
                      "itemStatus":  "Created",
                      "reasonCode":  "MOCK",
                      "reasonName":  "Mock seeded reason",
                      "createdAt":  "2026-01-20T21:26:18.832Z",
                      "updatedAt":  "2026-01-20T21:26:18.832Z"
                  },
                  {
                      "claimId":  "MOCK-CL-1768944378808-bd74c648-1",
                      "claimItemId":  "MOCK-CI-1aa121a1-745-1",
                      "sku":  "MOCK-SKU-1",
                      "barcode":  "MOCK-BARCODE-1",
                      "quantity":  1,
                      "itemStatus":  "WaitingInAction",
                      "reasonCode":  "MOCK",
                      "reasonName":  "Mock seeded reason",
                      "createdAt":  "2026-01-20T21:26:18.821Z",
                      "updatedAt":  "2026-01-20T21:26:18.821Z"
                  }
              ]
}

``n
### 4.5 GET /v1/claims/items/:claimItemId/audits (before commands)
#### itemA
`json

{
    "claimItemId":  "MOCK-CI-6c07a32b-5cb-1",
    "audits":  [
                   {
                       "previousStatus":  null,
                       "newStatus":  "Created",
                       "executorApp":  "MockSellerIntegrationApi",
                       "executorUser":  "mock",
                       "date":  "2026-01-21T06:41:11.440Z",
                       "raw":  {
                                   "mock":  true,
                                   "note":  "Seed audit (local only)"
                               }
                   },
                   {
                       "previousStatus":  "Created",
                       "newStatus":  "WaitingInAction",
                       "executorApp":  "MockSellerIntegrationApi",
                       "executorUser":  "mock",
                       "date":  "2026-01-21T06:41:11.441Z",
                       "raw":  {
                                   "mock":  true,
                                   "note":  "Seed audit (local only)"
                               }
                   }
               ]
}

``n
#### itemB
`json

{
    "claimItemId":  "MOCK-CI-ac85b455-9d0-1",
    "audits":  [
                   {
                       "previousStatus":  null,
                       "newStatus":  "Created",
                       "executorApp":  "MockSellerIntegrationApi",
                       "executorUser":  "mock",
                       "date":  "2026-01-21T06:41:12.440Z",
                       "raw":  {
                                   "mock":  true,
                                   "note":  "Seed audit (local only)"
                               }
                   },
                   {
                       "previousStatus":  "Created",
                       "newStatus":  "WaitingInAction",
                       "executorApp":  "MockSellerIntegrationApi",
                       "executorUser":  "mock",
                       "date":  "2026-01-21T06:41:12.441Z",
                       "raw":  {
                                   "mock":  true,
                                   "note":  "Seed audit (local only)"
                               }
                   }
               ]
}

``n
## 5) Command API Kanıtları (DEV/MOCK)

> Not: Gerçek Trendyol kuralı WaitingInAction, rate-limit vs. üretimde geçerli. Burada mock ile akış doğrulanır.


### 5.1 POST /v1/claims/:claimId/approve (claimA)
`json


``n
### 5.2 POST /v1/claims/:claimId/reject (claimB)
`json


``n
### 5.3 Audits (after commands)
#### itemA
`json

{
    "claimItemId":  "MOCK-CI-6c07a32b-5cb-1",
    "audits":  [
                   {
                       "previousStatus":  null,
                       "newStatus":  "Created",
                       "executorApp":  "MockSellerIntegrationApi",
                       "executorUser":  "mock",
                       "date":  "2026-01-21T06:41:11.440Z",
                       "raw":  {
                                   "mock":  true,
                                   "note":  "Seed audit (local only)"
                               }
                   },
                   {
                       "previousStatus":  "Created",
                       "newStatus":  "WaitingInAction",
                       "executorApp":  "MockSellerIntegrationApi",
                       "executorUser":  "mock",
                       "date":  "2026-01-21T06:41:11.441Z",
                       "raw":  {
                                   "mock":  true,
                                   "note":  "Seed audit (local only)"
                               }
                   }
               ]
}

``n
#### itemB
`json

{
    "claimItemId":  "MOCK-CI-ac85b455-9d0-1",
    "audits":  [
                   {
                       "previousStatus":  null,
                       "newStatus":  "Created",
                       "executorApp":  "MockSellerIntegrationApi",
                       "executorUser":  "mock",
                       "date":  "2026-01-21T06:41:12.440Z",
                       "raw":  {
                                   "mock":  true,
                                   "note":  "Seed audit (local only)"
                               }
                   },
                   {
                       "previousStatus":  "Created",
                       "newStatus":  "WaitingInAction",
                       "executorApp":  "MockSellerIntegrationApi",
                       "executorUser":  "mock",
                       "date":  "2026-01-21T06:41:12.441Z",
                       "raw":  {
                                   "mock":  true,
                                   "note":  "Seed audit (local only)"
                               }
                   }
               ]
}

``n
## 6) DB Kanıtları (Counts + Audit Join)

### 6.1 Counts (Claim/Item/Audit/Command)
`	ext

 claim_count | claim_item_count | claim_audit_count | claim_command_count 
-------------+------------------+-------------------+---------------------
           5 |                8 |                13 |                   0
(1 row)

``n

### 6.2 Audit Join (executorApp / status transitions)
`	ext

      claimItemId       | previousStatus |    newStatus    |       executorApp        | executorUser |            date            
------------------------+----------------+-----------------+--------------------------+--------------+----------------------------
 MOCK-CI-ac85b455-9d0-1 | Created        | WaitingInAction | MockSellerIntegrationApi | mock         | 2026-01-21 06:41:12.441+00
 MOCK-CI-ac85b455-9d0-1 |                | Created         | MockSellerIntegrationApi | mock         | 2026-01-21 06:41:12.44+00
 MOCK-CI-6c07a32b-5cb-1 | Created        | WaitingInAction | MockSellerIntegrationApi | mock         | 2026-01-21 06:41:11.441+00
 MOCK-CI-6c07a32b-5cb-1 |                | Created         | MockSellerIntegrationApi | mock         | 2026-01-21 06:41:11.44+00
 MOCK-CI-62131147-38c-2 |                | Created         | MockSellerIntegrationApi | mock         | 2026-01-21 06:29:25.898+00
 MOCK-CI-b7bdb4ad-00c-1 | Created        | WaitingInAction | MockSellerIntegrationApi | mock         | 2026-01-21 06:29:25.799+00
 MOCK-CI-b7bdb4ad-00c-1 |                | Created         | MockSellerIntegrationApi | mock         | 2026-01-21 06:29:25.798+00
 MOCK-CI-2d5206ae-07b-2 |                | Created         | MockSellerIntegrationApi | mock         | 2026-01-21 06:06:23.668+00
 MOCK-CI-6a3591f4-734-1 | Created        | WaitingInAction | MockSellerIntegrationApi | mock         | 2026-01-21 06:06:23.569+00
 MOCK-CI-6a3591f4-734-1 |                | Created         | MockSellerIntegrationApi | mock         | 2026-01-21 06:06:23.568+00
 MOCK-CI-9520d4e7-e3e-2 |                | Created         | SellerIntegrationApi     | mock         | 2026-01-20 21:26:18.909+00
 MOCK-CI-1aa121a1-745-1 | Created        | WaitingInAction | SellerIntegrationApi     | mock         | 2026-01-20 21:26:18.81+00
 MOCK-CI-1aa121a1-745-1 |                | Created         | SellerIntegrationApi     | mock         | 2026-01-20 21:26:18.809+00
(13 rows)

``n

## 7) Kapanış Notu

- Bu koşu DEV/MOCK olduğu için Trendyol tarafında executorApp=SellerIntegrationApi kanıtı yoktur.

- Test hesabında gerçek iade oluşmayacağı belirtildi. Gerçek proof gerektiğinde aynı akış gerçek claim ile çalıştırılıp sadece bu dosyaya ek yapılır.

