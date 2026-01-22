# ECI - Sprint 13 (QnA) - PROOF PACK

Rule: Do not move to the next step until the current step has **at least 2 proofs**
(typically: API response + DB query OR Worker log + DB query).

## 0) Mini Bulut (current status)
- Infra (Postgres + Redis): [ ]
- Core API: [ ]
- Core Worker: [ ]

---

## 1) Doc Alignment (Trendyol QnA Core Endpoints) - DONE
Core endpoint set (Trendyol.pdf):
- GET  /integration/qna/sellers/{sellerId}/questions/filter
- GET  /integration/qna/sellers/{sellerId}/questions/{id}
- POST /integration/qna/sellers/{sellerId}/questions/{id}/answers   body: { "text": "..." }

Notes:
- supplierId is required for list/filter.
- size max 50, paging via page/size.
- answer text length: min 10, max 2000.
- rate-limit: 50 requests / 10 seconds (429 otherwise).

---

## 2) DB - QnA Models (Question / Answer / QnaCommand) - DONE

### 2.1 Prisma migrate deploy output (Proof #1)
Paste the exact CLI output:
```txt
=== SPRINT13_STEP2: prisma:migrate ===

 1 2   m i g r a t i o n s   f o u n d   i n   p r i s m a / m i g r a t i o n s

 A p p l y i n g   m i g r a t i o n   ` 2 0 2 6 0 1 2 1 1 5 3 0 0 0 _ s p r i n t 1 3 _ q n a `

 T h e   f o l l o w i n g   m i g r a t i o n ( s )   h a v e   b e e n   a p p l i e d :

 m i g r a t i o n s /

                   2 0 2 6 0 1 2 1 1 5 3 0 0 0 _ s p r i n t 1 3 _ q n a /

                       m i g r a t i o n . s q l

 A l l   m i g r a t i o n s   h a v e   b e e n   s u c c e s s f u l l y   a p p l i e d .

 === SPRINT13_STEP2: prisma:generate ===

 E P E R M :   o p e r a t i o n   n o t   p e r m i t t e d ,   r e n a m e   ' C : \ d e v \ e c i \ n o d e _ m o d u l e s \ . p r i s m a \ c l i e n t \ q u e r y _ e n g i n e - w i n d o w s .

 d l l . n o d e . t m p 2 2 4 6 4 '   - >   ' C : \ d e v \ e c i \ n o d e _ m o d u l e s \ . p r i s m a \ c l i e n t \ q u e r y _ e n g i n e - w i n d o w s . d l l . n o d e '

 === SPRINT13_STEP2: prisma:migrate ===

 1 2   m i g r a t i o n s   f o u n d   i n   p r i s m a / m i g r a t i o n s

 N o   p e n d i n g   m i g r a t i o n s   t o   a p p l y .

 === SPRINT13_STEP2: prisma:generate ===

         G e n e r a t e d   P r i s m a   C l i e n t   ( v 6 . 1 9 . 0 )   t o   . \ . . \ . . \ n o d e _ m o d u l e s \ @ p r i s m a \ c l i e n t   i n   1 7 2 m s

 === SPRINT13_STEP2: prisma:migrate ===

 1 2   m i g r a t i o n s   f o u n d   i n   p r i s m a / m i g r a t i o n s

 N o   p e n d i n g   m i g r a t i o n s   t o   a p p l y .

 === SPRINT13_STEP2: prisma:generate ===

         G e n e r a t e d   P r i s m a   C l i e n t   ( v 6 . 1 9 . 0 )   t o   . \ . . \ . . \ n o d e _ m o d u l e s \ @ p r i s m a \ c l i e n t   i n   1 7 9 m s

PS C:\dev\eci>
PS C:\dev\eci> "=== SPRINT13_STEP2: prisma:migrate ===" | Out-File -FilePath $OUT -Encoding utf8 -Append
PS C:\dev\eci> cd $ROOT\services\core
PS C:\dev\eci\services\core> npm run prisma:migrate 2>&1 | Tee-Object -FilePath $OUT -Append
PS C:\dev\eci\services\core>
PS C:\dev\eci\services\core> "=== SPRINT13_STEP2: prisma:generate ===" | Out-File -FilePath $OUT -Encoding utf8 -Append
PS C:\dev\eci\services\core> npm run prisma:generate 2>&1 | Tee-Object -FilePath $OUT -Append
```

### 2.2 DB verification (tables + key columns) (Proof #2)
Paste the exact psql output:
```txt
=== SPRINT13_STEP2: db tables ===
table_name
------------
Answer
QnaCommand
Question
(3 rows)

=== SPRINT13_STEP2: Question columns ===
column_name
----------------
id
connectionId
marketplace
questionId
status
askedAt
lastModifiedAt
customerId
userName
showUserName
productName
productMainId
imageUrl
webUrl
text
raw
createdAt
updatedAt
(18 rows)
```

### 2.3 Summary
- Migration folder: 20260121153000_sprint13_qna
- Tables created: Question, Answer, QnaCommand

---

## 3) Trendyol Connector - QnA Client + Probe (TODO)
Expected proofs:
- Probe output (list paging + sample detail)
- Optional: raw HTTP response metadata or logs

---

## 4) Worker - SYNC_QNA_QUESTIONS (TODO)

### 4.0 SupplierId doğrulama / otomatik tespit (Proof)
Trendyol QnA list **supplierId** ister. Eğer yanlış supplierId set edilirse list 0 döner.

Run:
```powershell
cd services/core
npx tsx scripts/set-latest-trendyol-supplierid-from-db.ts
```

Paste output (JSON):
```txt
=== SPRINT13_STEP4_0: supplierId auto-detect ===
(paste)
```

Then re-probe:
```powershell
npx tsx scripts/qna-probe-latest-connection.ts WAITING_FOR_ANSWER > ..\..\Çıktılar_qna_probe_after_supplierid.txt
```

Expected:
- totalElements >= 1
- firstQuestionIds has at least 1 id

---

## 5) API - GET /v1/qna/questions (TODO)

## 6) Panel - /qna list + filters (TODO)

## 7) Worker - POST_QNA_ANSWER + QnaCommand idempotency (TODO)

## 8) API - POST answer (queue) (TODO)

## 9) Worker - POST_QNA_ANSWER (remote post + status update) (TODO)

## 10) Sprint 13 Closeout (TODO)
Checklist:
- Sync ran; DB has Question rows; sample 3 rows recorded
- API list proof recorded
- Post answer proof recorded (HTTP + DB Answer row + Question status update)
- Rate-limit/pagination note recorded


---

## 4.1) Worker Wiring + Enqueue Script (dry-run fetch) — DONE/DOING

**Goal:** Run `TRENDYOL_SYNC_QNA_QUESTIONS` in worker and confirm it fetches the first page (no DB writes yet).

### Proof A — Enqueue output (jobId + connectionId)
```json
{ "ok": true, "jobId": "...", "connectionId": "...", "status": "WAITING_FOR_ANSWER", "pageSize": 50 }
```

### Proof B — Worker log summary
- Must show: `syncQnaQuestions (dry-run) started` and `done` with `totalElements` + `fetched`.

### Notes
- Trendyol.pdf: `supplierId` is required, `size` max 50, paging via `page/size`, and date window rules apply.


## 4.2) Worker DB Upsert (Question + Answer) — TODO

**Goal:** Same job now writes `Question` and (if present) `Answer` rows for page=0.

### Proof A — Worker log summary
- Must show: `syncQnaQuestions started` and `done` with `questionsUpserted` / `answersUpserted`.

### Proof B — DB rows
```sql
select count(*) from "Question";
select "questionId","status","askedAt" from "Question" order by "askedAt" desc nulls last limit 3;
select count(*) from "Answer";
```

### Notes
- If `totalElements=0`, DB counts may remain unchanged; keep the worker summary + probe outputs as the evidence that the pipeline is healthy but dataset is empty.



---

## 4.4) Diagnostic — Why seller panel shows QnA but DB/API is empty

Goal: Prove whether the issue is **supplierId**, **sellerId/credentials**, or **status enum mismatch**.

### 4.4.1 Probe latest active Trendyol connection (Proof #1)

Run:
```powershell
cd services/core
npx tsx scripts/qna-probe-latest-connection.ts WAITING_FOR_ANSWER 10
```

Expected file:
- `services/core/proofs/qna_probe_latest_connection.json`

After run, record these in this section:
- cfg.sellerId
- cfg.supplierId (if present)
- envSupplier (if any)
- probes.fallbackSupplier_statusSweep
- probes.fallbackSupplier_firstHit (if any)

### 4.4.2 Interpretation

- If `fallbackSupplier_statusSweep.WAITING_FOR_ANSWER.totalElements > 0`:
  - QnA exists and the sellerId/supplierId are correct; the issue is in our sync pipeline (job scheduling, DB upsert mapping, or API list).
- If `fallbackSupplier_statusSweep.*.totalElements == 0` for all statuses:
  - Most likely sellerId/credentials point to a different seller than the panel account, OR supplierId is wrong/missing.
- If `envSupplier_requestedStatus.totalElements == 0` but `fallbackSupplier_requestedStatus.totalElements > 0`:
  - `TRENDYOL_SUPPLIER_ID` override is wrong and should be removed/ignored in worker.

(Once we have Proof #1, we apply the smallest fix in Step 4.5 and re-run sync.)
