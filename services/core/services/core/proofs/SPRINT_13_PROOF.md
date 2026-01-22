# ECI - Sprint 13 (QnA) - PROOF

GeneratedAt (UTC): 2026-01-21 10:59:03
Base URL: http://127.0.0.1:3001

> Rule: This file is the single source of truth for Sprint 13 proofs.  
> Every step must include at least **2 proofs** (API response + DB query and/or worker logs).

---

## Step 0) Scope & Trendyol Endpoint Set (locked)

**Questions List (filter/paging)**  
`GET /integration/qna/sellers/{sellerId}/questions/filter`  
- supplierId required
- size max 50
- status enum: WAITING_FOR_ANSWER | WAITING_FOR_APPROVE | ANSWERED | REPORTED | REJECTED
- time window: default last 1 week, max 2 weeks with startDate/endDate

**Question Detail**  
`GET /integration/qna/sellers/{sellerId}/questions/{id}`

**Create Answer**  
`POST /integration/qna/sellers/{sellerId}/questions/{id}/answers` body: `{"text":"..."}` (10..2000 chars)

---

## Step 1) Skeleton (routes wiring)
Status: TODO

Proofs:
- [ ] API boots and exposes Sprint 13 routes (even if Not Implemented)
- [ ] Health check OK

---

## Step 2) DB Models + Migration (DONE)

Goal: Add `Question`, `Answer`, `QnaCommand` tables (unique + indexes + relations).

### 2.1 Migration deploy (Proof #1)
Migration ID (Prisma): `20260121153000_sprint13_qna`  
Expected: "All migrations have been successfully applied."

Commands (ran by stajyer):
```powershell
cd services/core
npm run prisma:migrate
```

Result (summary):
- ✅ Migrations applied successfully.

### 2.2 DB tables exist (Proof #2)
Commands:
```powershell
docker exec infra-postgres-1 psql -U eci -d eci -c "select table_name from information_schema.tables where table_schema='public' and table_name in ('Question','Answer','QnaCommand') order by table_name;"
```

Observed:
```text
Answer
QnaCommand
Question
```

### 2.3 Question columns sanity (Proof #3)
Commands:
```powershell
docker exec infra-postgres-1 psql -U eci -d eci -c "select column_name from information_schema.columns where table_name='Question' order by ordinal_position;"
```

Observed (columns):
```text
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
```

### 2.4 Prisma generate note (Windows EPERM)
- First attempt can fail with `EPERM` due to file lock.
- Rerun `npm run prisma:generate` after stopping node processes fixes it.

---

## Step 3) Trendyol Connector - QnA Client (TODO)

Goal: Implement:
- `qnaQuestionsFilter`
- `qnaQuestionById`
- `qnaCreateAnswer`

Proofs:
- [ ] qna_probe list output (totalElements/totalPages + firstQuestionIds)
- [ ] qna_probe detail output (sampleDetail or explicit "no questions" message)

Attach here:
```text
(paste qna_probe output)
```

---

## Step 4) Worker - SYNC_QNA_QUESTIONS (TODO)

Proofs:
- [ ] Worker job log (pages fetched + backoff if any)
- [ ] DB: `Question` count + 3 sample rows

---

## Step 5) API Read Endpoints (TODO)

Proofs:
- [ ] GET /v1/qna/questions JSON (page)
- [ ] DB query matches count/status

---

## Step 6) UI - List & Filter (TODO)

Proofs:
- [ ] Screenshot (panel /qna list)
- [ ] Network response JSON for list endpoint

---

## Step 7) Command - POST Answer (queue) (TODO)

Proofs:
- [ ] HTTP 200/201 + returned jobId
- [ ] DB: QnaCommand created (idempotency key present)

---

## Step 8) Worker - POST_QNA_ANSWER (TODO)

Proofs:
- [ ] Trendyol response (200) or explicit error logged
- [ ] DB: Answer row + Question.status updated

---

## Step 9) Rate-limit / Pagination Notes (TODO)

Proofs:
- [ ] total API calls for sync run
- [ ] any 429/backoff evidence

---

## Step 10) Closeout Checklist (TODO)

- [ ] SYNC_QNA_QUESTIONS OK
- [ ] Panel list OK
- [ ] POST answer OK
- [ ] Proofs complete
