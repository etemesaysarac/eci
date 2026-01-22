-- Sprint 13: QnA (Questions / Answers)
-- Idempotent by design.

CREATE TABLE IF NOT EXISTS "Question" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL DEFAULT 'trendyol',

  "questionId" TEXT NOT NULL,

  "status" TEXT,
  "askedAt" TIMESTAMPTZ,
  "lastModifiedAt" TIMESTAMPTZ,

  "customerId" TEXT,
  "userName" TEXT,
  "showUserName" BOOLEAN,

  "productName" TEXT,
  "productMainId" TEXT,
  "imageUrl" TEXT,
  "webUrl" TEXT,

  "text" TEXT,
  "raw" JSONB NOT NULL,

  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "Question_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Question_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Question_connectionId_marketplace_questionId_key"
  ON "Question" ("connectionId", "marketplace", "questionId");

CREATE INDEX IF NOT EXISTS "Question_connectionId_idx" ON "Question"("connectionId");
CREATE INDEX IF NOT EXISTS "Question_questionId_idx" ON "Question"("questionId");
CREATE INDEX IF NOT EXISTS "Question_status_idx" ON "Question"("status");
CREATE INDEX IF NOT EXISTS "Question_askedAt_idx" ON "Question"("askedAt");


CREATE TABLE IF NOT EXISTS "Answer" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL DEFAULT 'trendyol',

  "questionDbId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,

  "answerText" TEXT NOT NULL,
  "answeredAt" TIMESTAMPTZ,

  "executorApp" TEXT,
  "executorUser" TEXT,

  "raw" JSONB,

  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "Answer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Answer_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Answer_questionDbId_fkey" FOREIGN KEY ("questionDbId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Answer_connectionId_marketplace_questionId_key"
  ON "Answer" ("connectionId", "marketplace", "questionId");

CREATE INDEX IF NOT EXISTS "Answer_connectionId_idx" ON "Answer"("connectionId");
CREATE INDEX IF NOT EXISTS "Answer_questionDbId_idx" ON "Answer"("questionDbId");
CREATE INDEX IF NOT EXISTS "Answer_answeredAt_idx" ON "Answer"("answeredAt");


CREATE TABLE IF NOT EXISTS "QnaCommand" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL DEFAULT 'trendyol',

  "questionDbId" TEXT,
  "questionId" TEXT,

  "commandType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',

  "idempotencyKey" TEXT NOT NULL,

  "request" JSONB NOT NULL,
  "response" JSONB,
  "error" TEXT,

  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "QnaCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QnaCommand_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "QnaCommand_questionDbId_fkey" FOREIGN KEY ("questionDbId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_qna_command_idem"
  ON "QnaCommand" ("connectionId", "marketplace", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "QnaCommand_connectionId_idx" ON "QnaCommand"("connectionId");
CREATE INDEX IF NOT EXISTS "QnaCommand_questionId_idx" ON "QnaCommand"("questionId");
CREATE INDEX IF NOT EXISTS "QnaCommand_commandType_idx" ON "QnaCommand"("commandType");
CREATE INDEX IF NOT EXISTS "QnaCommand_status_idx" ON "QnaCommand"("status");
