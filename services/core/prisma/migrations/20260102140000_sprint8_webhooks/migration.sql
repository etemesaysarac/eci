-- Sprint 8: WebhookSubscription + WebhookEvent

CREATE TABLE IF NOT EXISTS "WebhookSubscription" (
  "id" TEXT PRIMARY KEY,
  "connectionId" TEXT NOT NULL REFERENCES "Connection"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL,
  "remoteWebhookId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "endpointUrl" TEXT NOT NULL,
  "authenticationType" TEXT NOT NULL,
  "apiKeyHash" TEXT,
  "basicUsername" TEXT,
  "basicPasswordHash" TEXT,
  "subscribedStatuses" JSONB,
  "secretsEnc" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebhookSubscription_connectionId_provider_key'
  ) THEN
    ALTER TABLE "WebhookSubscription"
      ADD CONSTRAINT "WebhookSubscription_connectionId_provider_key"
      UNIQUE ("connectionId","provider");
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "WebhookSubscription_remoteWebhookId_idx"
  ON "WebhookSubscription"("remoteWebhookId");
CREATE INDEX IF NOT EXISTS "WebhookSubscription_apiKeyHash_idx"
  ON "WebhookSubscription"("apiKeyHash");
CREATE INDEX IF NOT EXISTS "WebhookSubscription_basicUsername_idx"
  ON "WebhookSubscription"("basicUsername");

CREATE TABLE IF NOT EXISTS "WebhookEvent" (
  "id" TEXT PRIMARY KEY,
  "connectionId" TEXT NOT NULL REFERENCES "Connection"("id") ON DELETE CASCADE,
  "subscriptionId" TEXT NOT NULL REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL,
  "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "eventKey" TEXT NOT NULL,
  "bodyHash" TEXT NOT NULL,
  "headers" JSONB,
  "rawBody" JSONB,
  "rawBodyText" TEXT,
  "verifyStatus" TEXT NOT NULL DEFAULT 'ok',
  "dedupHit" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebhookEvent_eventKey_key'
  ) THEN
    ALTER TABLE "WebhookEvent"
      ADD CONSTRAINT "WebhookEvent_eventKey_key"
      UNIQUE ("eventKey");
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "WebhookEvent_connectionId_receivedAt_idx"
  ON "WebhookEvent"("connectionId","receivedAt");
CREATE INDEX IF NOT EXISTS "WebhookEvent_subscriptionId_receivedAt_idx"
  ON "WebhookEvent"("subscriptionId","receivedAt");
