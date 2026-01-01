-- Sprint 7.1: schema alignment for worker + action audit
--
-- This migration is intentionally small and additive:
-- - Adds Job.updatedAt (initial migration did not include it)
-- - Creates ShipmentPackage (worker upsert target)
-- - Creates shipment_package_action (audit log for write actions)

-- 1) Job.updatedAt
ALTER TABLE "Job"
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;


-- 2) ShipmentPackage table (worker upsert target)
CREATE TABLE IF NOT EXISTS "ShipmentPackage" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL DEFAULT 'trendyol',
  "shipmentPackageId" TEXT NOT NULL,
  "status" TEXT,
  "raw" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShipmentPackage_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i'
      AND c.relname = 'ShipmentPackage_connectionId_marketplace_shipmentPackageId_key'
  ) THEN
    CREATE UNIQUE INDEX "ShipmentPackage_connectionId_marketplace_shipmentPackageId_key"
      ON "ShipmentPackage"("connectionId","marketplace","shipmentPackageId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ShipmentPackage_connectionId_idx"
  ON "ShipmentPackage"("connectionId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ShipmentPackage_connectionId_fkey'
  ) THEN
    ALTER TABLE "ShipmentPackage"
      ADD CONSTRAINT "ShipmentPackage_connectionId_fkey"
      FOREIGN KEY ("connectionId") REFERENCES "Connection"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- 3) shipment_package_action (Sprint 7 write-audit)
CREATE TABLE IF NOT EXISTS "shipment_package_action" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "shipmentPackageId" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "response" JSONB,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shipment_package_action_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "shipment_package_action_connectionId_shipmentPackageId_idx"
  ON "shipment_package_action"("connectionId","shipmentPackageId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shipment_package_action_connectionId_fkey'
  ) THEN
    ALTER TABLE "shipment_package_action"
      ADD CONSTRAINT "shipment_package_action_connectionId_fkey"
      FOREIGN KEY ("connectionId") REFERENCES "Connection"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
