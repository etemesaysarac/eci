-- Sprint 10: confirmed inventory state (used for changed-only diff)
-- Idempotent by design.

CREATE TABLE IF NOT EXISTS "inventory_confirmed_state" (
  "connectionId" TEXT NOT NULL,
  "barcode" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "salePrice" DECIMAL(18,4) NOT NULL,
  "listPrice" DECIMAL(18,4) NOT NULL,
  "currencyType" TEXT,
  "lastBatchRequestId" TEXT,
  "lastConfirmedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_confirmed_state_pkey" PRIMARY KEY ("connectionId", "barcode"),
  CONSTRAINT "inventory_confirmed_state_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "inventory_confirmed_state_connectionId_idx" ON "inventory_confirmed_state"("connectionId");
CREATE INDEX IF NOT EXISTS "inventory_confirmed_state_barcode_idx" ON "inventory_confirmed_state"("barcode");
