-- Sprint 9: Product catalog domain

CREATE TABLE IF NOT EXISTS "Product" (
  "id" TEXT PRIMARY KEY,
  "connectionId" TEXT NOT NULL REFERENCES "Connection"("id") ON DELETE CASCADE,
  "productCode" TEXT NOT NULL,
  "brandId" INTEGER,
  "categoryId" INTEGER,
  "title" TEXT,
  "description" TEXT,
  "approved" BOOLEAN,
  "archived" BOOLEAN NOT NULL DEFAULT FALSE,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "Product_connectionId_productCode_key"
ON "Product"("connectionId", "productCode");

CREATE INDEX IF NOT EXISTS "Product_connectionId_idx" ON "Product"("connectionId");
CREATE INDEX IF NOT EXISTS "Product_brandId_idx" ON "Product"("brandId");
CREATE INDEX IF NOT EXISTS "Product_categoryId_idx" ON "Product"("categoryId");

CREATE TABLE IF NOT EXISTS "ProductVariant" (
  "id" TEXT PRIMARY KEY,
  "connectionId" TEXT NOT NULL REFERENCES "Connection"("id") ON DELETE CASCADE,
  "productId" TEXT NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
  "barcode" TEXT NOT NULL,
  "stockCode" TEXT,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductVariant_connectionId_barcode_key"
ON "ProductVariant"("connectionId", "barcode");

CREATE INDEX IF NOT EXISTS "ProductVariant_connectionId_idx" ON "ProductVariant"("connectionId");
CREATE INDEX IF NOT EXISTS "ProductVariant_productId_idx" ON "ProductVariant"("productId");

CREATE TABLE IF NOT EXISTS "ProductBatchRequest" (
  "id" TEXT PRIMARY KEY,
  "connectionId" TEXT NOT NULL REFERENCES "Connection"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "remoteBatchId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'CREATED',
  "payload" JSONB,
  "errors" JSONB,
  "lastCheckedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "ProductBatchRequest_connectionId_idx" ON "ProductBatchRequest"("connectionId");
CREATE INDEX IF NOT EXISTS "ProductBatchRequest_remoteBatchId_idx" ON "ProductBatchRequest"("remoteBatchId");
