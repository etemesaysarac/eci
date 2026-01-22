import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { PrismaClient } from "@prisma/client";

/**
 * Sprint 13 — Step 4.1
 * Enqueue TRENDYOL_SYNC_QNA_QUESTIONS without asking the user to manually search for ids.
 *
 * Behavior:
 * - Loads .env from ECI_ENV_FILE (if set) else cwd/.env (override=true)
 * - Picks the most recently created active Trendyol connection (unless CONNECTION_ID is provided)
 * - Creates Job row + acquires per-connection lock (same pattern as server routes)
 * - Enqueues the worker job with stable name "TRENDYOL_SYNC_QNA_QUESTIONS"
 *
 * Usage:
 *   cd services/core
 *   npx tsx scripts/enqueue-trendyol-qna-sync.ts
 *
 * Optional args:
 *   npx tsx scripts/enqueue-trendyol-qna-sync.ts WAITING_FOR_ANSWER
 *   npx tsx scripts/enqueue-trendyol-qna-sync.ts ANSWERED 50
 */
function loadEnv() {
  const explicit = (process.env.ECI_ENV_FILE ?? "").trim();
  const p = explicit ? path.resolve(explicit) : path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(p)) {
    console.warn(`[enqueue-qna] .env not found at ${p} (continuing)`);
    return;
  }
  const res = dotenv.config({ path: p, override: true });
  const n = res.parsed ? Object.keys(res.parsed).length : 0;
  console.log(`[enqueue-qna] loaded .env from ${p} (keys=${n}, override=true)`);
}

function syncLockKey(connectionId: string) {
  return `eci:sync:lock:${connectionId}`;
}

async function main() {
  loadEnv();

  const statusArg = (process.argv[2] ?? "").trim();
  const pageSizeArg = (process.argv[3] ?? "").trim();

  const status = statusArg.length ? statusArg : "WAITING_FOR_ANSWER";
  const pageSizeRaw = pageSizeArg.length ? Number(pageSizeArg) : 50;
  const pageSize = Math.min(Math.max(Number.isFinite(pageSizeRaw) ? pageSizeRaw : 50, 1), 50);

  const prisma = new PrismaClient();
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("eci-jobs", { connection: redis });

  try {
    const explicitId = (process.env.CONNECTION_ID ?? "").trim();
    const conn = explicitId
      ? await prisma.connection.findUnique({ where: { id: explicitId }, select: { id: true, type: true, status: true } })
      : await prisma.connection.findFirst({
          where: { type: "trendyol", status: "active" },
          orderBy: { createdAt: "desc" },
          select: { id: true, type: true, status: true },
        });

    if (!conn) {
      throw new Error("No active Trendyol connection found. Set CONNECTION_ID to force one.");
    }
    if (conn.type !== "trendyol") {
      throw new Error(`Connection type is not trendyol: ${conn.type}`);
    }

    const connectionId = conn.id;

    // Acquire per-connection lock (same pattern as server routes)
    const SYNC_LOCK_TTL_MS = Number(process.env.SYNC_LOCK_TTL_MS ?? 60 * 60 * 1000);
    const lockKey = syncLockKey(connectionId);
    const pending = `pending:${cryptoRandom()}`;
    const acquired = await redis.set(lockKey, pending, "PX", SYNC_LOCK_TTL_MS, "NX");

    if (acquired !== "OK") {
      const lockOwner = await redis.get(lockKey);
      throw new Error(`Sync lock is already held for this connection. lockOwner=${lockOwner ?? "?"}`);
    }

    const jobRow = await prisma.job.create({
      data: {
        connectionId,
        type: "TRENDYOL_SYNC_QNA_QUESTIONS",
        status: "queued",
      },
      select: { id: true },
    });

    // lock owner must be jobId (worker can refresh/release)
    await redis.set(lockKey, jobRow.id, "PX", SYNC_LOCK_TTL_MS);

    await queue.add(
      "TRENDYOL_SYNC_QNA_QUESTIONS",
      { jobId: jobRow.id, connectionId, params: { status, pageSize } },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      }
    );

    console.log(JSON.stringify({ ok: true, jobId: jobRow.id, connectionId, status, pageSize }, null, 2));
  } finally {
    await queue.close().catch(() => {});
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

function cryptoRandom() {
  // tiny random token without importing crypto (tsx on windows sometimes quirks)
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
