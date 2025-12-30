-- CreateTable
CREATE TABLE "sync_state" (
    "connectionId" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastJobId" TEXT,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("connectionId")
);

-- CreateIndex
CREATE INDEX "sync_state_updatedAt_idx" ON "sync_state"("updatedAt");

-- AddForeignKey
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
