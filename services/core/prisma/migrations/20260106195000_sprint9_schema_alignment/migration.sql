-- Sprint 9 schema alignment (for DBs created before "sprint9_products" migration existed)
-- Goal: make Product / ProductVariant / ProductBatchRequest compatible with current API queries.

-- Product: ensure marketplace + core columns exist
ALTER TABLE IF EXISTS "Product" ADD COLUMN IF NOT EXISTS "marketplace" TEXT;
UPDATE "Product" SET "marketplace" = 'trendyol' WHERE "marketplace" IS NULL;
ALTER TABLE IF EXISTS "Product" ALTER COLUMN "marketplace" SET DEFAULT 'trendyol';
-- Do NOT force NOT NULL if older rows might exist; we set defaults + backfill above.

ALTER TABLE IF EXISTS "Product" ADD COLUMN IF NOT EXISTS "primaryBarcode" TEXT;
ALTER TABLE IF EXISTS "Product" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE IF EXISTS "Product" ADD COLUMN IF NOT EXISTS "approved" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS "Product" ADD COLUMN IF NOT EXISTS "archived" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS "Product" ADD COLUMN IF NOT EXISTS "raw" JSONB;
UPDATE "Product" SET "raw" = '{}'::jsonb WHERE "raw" IS NULL;
ALTER TABLE IF EXISTS "Product" ALTER COLUMN "raw" SET NOT NULL;

-- timestamps: make inserts safer if app code doesn't set them
ALTER TABLE IF EXISTS "Product" ALTER COLUMN "createdAt" SET DEFAULT NOW();
ALTER TABLE IF EXISTS "Product" ALTER COLUMN "updatedAt" SET DEFAULT NOW();

-- ProductVariant: ensure marketplace + pricing fields exist
ALTER TABLE IF EXISTS "ProductVariant" ADD COLUMN IF NOT EXISTS "marketplace" TEXT;
UPDATE "ProductVariant" SET "marketplace" = 'trendyol' WHERE "marketplace" IS NULL;
ALTER TABLE IF EXISTS "ProductVariant" ALTER COLUMN "marketplace" SET DEFAULT 'trendyol';

ALTER TABLE IF EXISTS "ProductVariant" ADD COLUMN IF NOT EXISTS "stock" INTEGER;
ALTER TABLE IF EXISTS "ProductVariant" ADD COLUMN IF NOT EXISTS "listPrice" DOUBLE PRECISION;
ALTER TABLE IF EXISTS "ProductVariant" ADD COLUMN IF NOT EXISTS "salePrice" DOUBLE PRECISION;
ALTER TABLE IF EXISTS "ProductVariant" ADD COLUMN IF NOT EXISTS "currency" TEXT;

ALTER TABLE IF EXISTS "ProductVariant" ADD COLUMN IF NOT EXISTS "raw" JSONB;
UPDATE "ProductVariant" SET "raw" = '{}'::jsonb WHERE "raw" IS NULL;
ALTER TABLE IF EXISTS "ProductVariant" ALTER COLUMN "raw" SET NOT NULL;

ALTER TABLE IF EXISTS "ProductVariant" ALTER COLUMN "createdAt" SET DEFAULT NOW();
ALTER TABLE IF EXISTS "ProductVariant" ALTER COLUMN "updatedAt" SET DEFAULT NOW();

-- ProductBatchRequest: align to API shape (marketplace + payloadSummary)
ALTER TABLE IF EXISTS "ProductBatchRequest" ADD COLUMN IF NOT EXISTS "marketplace" TEXT;
UPDATE "ProductBatchRequest" SET "marketplace" = 'trendyol' WHERE "marketplace" IS NULL;
ALTER TABLE IF EXISTS "ProductBatchRequest" ALTER COLUMN "marketplace" SET DEFAULT 'trendyol';

ALTER TABLE IF EXISTS "ProductBatchRequest" ADD COLUMN IF NOT EXISTS "payloadSummary" JSONB;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ProductBatchRequest'
      AND column_name = 'payload'
  ) THEN
    UPDATE "ProductBatchRequest"
    SET "payloadSummary" = COALESCE("payloadSummary", "payload")
    WHERE "payloadSummary" IS NULL;
  END IF;
END $$;

-- ensure timestamps exist (some early tables used "updatedAt" without default; some used different types)
ALTER TABLE IF EXISTS "ProductBatchRequest" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ;
ALTER TABLE IF EXISTS "ProductBatchRequest" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ;

UPDATE "ProductBatchRequest" SET "createdAt" = NOW() WHERE "createdAt" IS NULL;
UPDATE "ProductBatchRequest" SET "updatedAt" = NOW() WHERE "updatedAt" IS NULL;

ALTER TABLE IF EXISTS "ProductBatchRequest" ALTER COLUMN "createdAt" SET DEFAULT NOW();
ALTER TABLE IF EXISTS "ProductBatchRequest" ALTER COLUMN "updatedAt" SET DEFAULT NOW();
