-- Sprint 14 — Finance / Mutabakat (DB)
-- Creates: Settlement, FinancialTxn, CargoInvoiceItem
-- NOTE: We intentionally avoid `IF NOT EXISTS` on CREATE INDEX / ADD CONSTRAINT for broad Postgres compatibility.
--       We use DO blocks + duplicate_object handling to make this migration safely re-runnable if needed.

CREATE TABLE IF NOT EXISTS "Settlement" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL DEFAULT 'trendyol',
  "sellerId" TEXT NOT NULL,
  "transactionType" TEXT NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "paymentOrderId" TEXT,
  "orderNumber" TEXT,
  "settlementDate" TIMESTAMP(3),
  "currencyType" INTEGER,
  "grossAmount" DOUBLE PRECISION,
  "commissionAmount" DOUBLE PRECISION,
  "vatAmount" DOUBLE PRECISION,
  "netAmount" DOUBLE PRECISION,
  "dedupeKey" TEXT NOT NULL,
  "raw" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  CREATE UNIQUE INDEX "Settlement_dedupeKey_key" ON "Settlement"("dedupeKey");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "Settlement_connectionId_transactionType_startDate_endDate_idx" ON "Settlement"("connectionId", "transactionType", "startDate", "endDate");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "Settlement_paymentOrderId_idx" ON "Settlement"("paymentOrderId");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "Settlement_orderNumber_idx" ON "Settlement"("orderNumber");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Settlement"
    ADD CONSTRAINT "Settlement_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


CREATE TABLE IF NOT EXISTS "FinancialTxn" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL DEFAULT 'trendyol',
  "sellerId" TEXT NOT NULL,
  "transactionType" TEXT NOT NULL,
  "transactionDate" TIMESTAMP(3),
  "description" TEXT,
  "debit" DOUBLE PRECISION,
  "credit" DOUBLE PRECISION,
  "currencyType" INTEGER,
  "paymentOrderId" TEXT,
  "orderNumber" TEXT,
  "barcode" TEXT,
  "invoiceSerialNumber" TEXT,
  "invoiceNumber" TEXT,
  "dedupeKey" TEXT NOT NULL,
  "raw" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FinancialTxn_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  CREATE UNIQUE INDEX "FinancialTxn_dedupeKey_key" ON "FinancialTxn"("dedupeKey");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "FinancialTxn_connectionId_transactionType_idx" ON "FinancialTxn"("connectionId", "transactionType");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "FinancialTxn_transactionDate_idx" ON "FinancialTxn"("transactionDate");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "FinancialTxn_paymentOrderId_idx" ON "FinancialTxn"("paymentOrderId");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "FinancialTxn_orderNumber_idx" ON "FinancialTxn"("orderNumber");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "FinancialTxn_barcode_idx" ON "FinancialTxn"("barcode");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "FinancialTxn_invoiceSerialNumber_invoiceNumber_idx" ON "FinancialTxn"("invoiceSerialNumber", "invoiceNumber");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "FinancialTxn"
    ADD CONSTRAINT "FinancialTxn_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


CREATE TABLE IF NOT EXISTS "CargoInvoiceItem" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL DEFAULT 'trendyol',
  "sellerId" TEXT NOT NULL,
  "invoiceSerialNumber" TEXT NOT NULL,
  "invoiceNumber" TEXT,
  "invoiceDate" TIMESTAMP(3),
  "currencyType" INTEGER,
  "totalAmount" DOUBLE PRECISION,
  "dedupeKey" TEXT NOT NULL,
  "raw" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CargoInvoiceItem_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  CREATE UNIQUE INDEX "CargoInvoiceItem_dedupeKey_key" ON "CargoInvoiceItem"("dedupeKey");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "CargoInvoiceItem_connectionId_invoiceSerialNumber_invoiceNumber_idx" ON "CargoInvoiceItem"("connectionId", "invoiceSerialNumber", "invoiceNumber");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CargoInvoiceItem"
    ADD CONSTRAINT "CargoInvoiceItem_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
