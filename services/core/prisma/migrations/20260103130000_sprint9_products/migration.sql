-- Sprint 9: Product catalog tables (Trendyol)
-- Created: 2026-01-03

CREATE TABLE IF NOT EXISTS "Product" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "productCode" TEXT NOT NULL,
  "title" TEXT,
  "primaryBarcode" TEXT,
  "brandId" INTEGER,
  "categoryId" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "approved" BOOLEAN NOT NULL DEFAULT false,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "raw" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "Product_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Product_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Product_connectionId_marketplace_productCode_key"
  ON "Product" ("connectionId", "marketplace", "productCode");

CREATE INDEX IF NOT EXISTS "Product_connectionId_updatedAt_idx"
  ON "Product" ("connectionId", "updatedAt");

CREATE INDEX IF NOT EXISTS "Product_connectionId_approved_idx"
  ON "Product" ("connectionId", "approved");

CREATE INDEX IF NOT EXISTS "Product_connectionId_archived_idx"
  ON "Product" ("connectionId", "archived");

CREATE INDEX IF NOT EXISTS "Product_connectionId_brandId_idx"
  ON "Product" ("connectionId", "brandId");

CREATE INDEX IF NOT EXISTS "Product_connectionId_categoryId_idx"
  ON "Product" ("connectionId", "categoryId");



CREATE TABLE IF NOT EXISTS "ProductVariant" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "barcode" TEXT NOT NULL,
  "stock" INTEGER,
  "listPrice" DOUBLE PRECISION,
  "salePrice" DOUBLE PRECISION,
  "currency" TEXT,
  "raw" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductVariant_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductVariant_connectionId_marketplace_barcode_key"
  ON "ProductVariant" ("connectionId", "marketplace", "barcode");

CREATE INDEX IF NOT EXISTS "ProductVariant_productId_idx"
  ON "ProductVariant" ("productId");

CREATE INDEX IF NOT EXISTS "ProductVariant_connectionId_updatedAt_idx"
  ON "ProductVariant" ("connectionId", "updatedAt");



CREATE TABLE IF NOT EXISTS "ProductBatchRequest" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "remoteBatchId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "payloadSummary" JSONB,
  "errors" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "ProductBatchRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductBatchRequest_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ProductBatchRequest_connectionId_createdAt_idx"
  ON "ProductBatchRequest" ("connectionId", "createdAt");

CREATE INDEX IF NOT EXISTS "ProductBatchRequest_connectionId_status_idx"
  ON "ProductBatchRequest" ("connectionId", "status");
