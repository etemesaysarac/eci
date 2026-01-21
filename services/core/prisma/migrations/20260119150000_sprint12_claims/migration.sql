-- Sprint 12: Claims / Iade (Trendyol)
-- Idempotent by design.

CREATE TABLE IF NOT EXISTS "Claim" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,

  "claimId" TEXT NOT NULL,
  "status" TEXT,
  "orderNumber" TEXT,
  "claimDate" TIMESTAMPTZ,
  "lastModifiedAt" TIMESTAMPTZ,

  "raw" JSONB NOT NULL,

  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "Claim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Claim_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Claim_connectionId_marketplace_claimId_key"
  ON "Claim" ("connectionId", "marketplace", "claimId");

CREATE INDEX IF NOT EXISTS "Claim_connectionId_idx" ON "Claim"("connectionId");
CREATE INDEX IF NOT EXISTS "Claim_claimId_idx" ON "Claim"("claimId");
CREATE INDEX IF NOT EXISTS "Claim_status_idx" ON "Claim"("status");


CREATE TABLE IF NOT EXISTS "ClaimItem" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,

  "claimDbId" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  "claimItemId" TEXT NOT NULL,

  "barcode" TEXT,
  "sku" TEXT,
  "quantity" INTEGER,
  "itemStatus" TEXT,

  "reasonCode" TEXT,
  "reasonName" TEXT,

  "raw" JSONB NOT NULL,

  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "ClaimItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClaimItem_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClaimItem_claimDbId_fkey" FOREIGN KEY ("claimDbId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ClaimItem_connectionId_marketplace_claimItemId_key"
  ON "ClaimItem" ("connectionId", "marketplace", "claimItemId");

CREATE INDEX IF NOT EXISTS "ClaimItem_connectionId_idx" ON "ClaimItem"("connectionId");
CREATE INDEX IF NOT EXISTS "ClaimItem_claimDbId_idx" ON "ClaimItem"("claimDbId");
CREATE INDEX IF NOT EXISTS "ClaimItem_claimItemId_idx" ON "ClaimItem"("claimItemId");
CREATE INDEX IF NOT EXISTS "ClaimItem_barcode_idx" ON "ClaimItem"("barcode");


CREATE TABLE IF NOT EXISTS "ClaimAudit" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,

  "claimItemDbId" TEXT NOT NULL,

  "previousStatus" TEXT,
  "newStatus" TEXT,
  "executorApp" TEXT,
  "executorUser" TEXT,
  "date" TIMESTAMPTZ NOT NULL,

  "raw" JSONB NOT NULL,

  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "ClaimAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClaimAudit_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClaimAudit_claimItemDbId_fkey" FOREIGN KEY ("claimItemDbId") REFERENCES "ClaimItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ClaimAudit_connectionId_marketplace_claimItemDbId_date_newStatus_key"
  ON "ClaimAudit" ("connectionId", "marketplace", "claimItemDbId", "date", "newStatus");

CREATE INDEX IF NOT EXISTS "ClaimAudit_connectionId_idx" ON "ClaimAudit"("connectionId");
CREATE INDEX IF NOT EXISTS "ClaimAudit_claimItemDbId_idx" ON "ClaimAudit"("claimItemDbId");
CREATE INDEX IF NOT EXISTS "ClaimAudit_date_idx" ON "ClaimAudit"("date");


CREATE TABLE IF NOT EXISTS "ClaimCommand" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,

  "claimId" TEXT,
  "commandType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',

  "request" JSONB NOT NULL,
  "response" JSONB,
  "error" TEXT,

  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "ClaimCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClaimCommand_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ClaimCommand_connectionId_idx" ON "ClaimCommand"("connectionId");
CREATE INDEX IF NOT EXISTS "ClaimCommand_claimId_idx" ON "ClaimCommand"("claimId");
CREATE INDEX IF NOT EXISTS "ClaimCommand_commandType_idx" ON "ClaimCommand"("commandType");
CREATE INDEX IF NOT EXISTS "ClaimCommand_status_idx" ON "ClaimCommand"("status");
