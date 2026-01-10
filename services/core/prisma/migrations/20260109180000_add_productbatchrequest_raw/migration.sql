-- Hotfix: align DB with current Prisma schema
-- Reason: Prisma model `ProductBatchRequest` includes `raw` (Json?) but some DBs were created
-- using earlier Sprint 9 migrations where the column does not exist.
--
-- This migration is intentionally idempotent.

ALTER TABLE IF EXISTS "ProductBatchRequest"
  ADD COLUMN IF NOT EXISTS "raw" JSONB;
