import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { PrismaClient } from "@prisma/client";

/**
 * Sprint 13 — QnA Sync Enqueue
 *
 * Enqueues TRENDYOL_SYNC_QNA_QUESTIONS with a safe 14-day max window.
 *
 * Supported styles:
 * 1) Flags (recommended):
 *    npx tsx scripts/enqueue-trendyol-qna-sync.ts --connectionId <id> --days 14 --status WAITING_FOR_ANSWER --pageSize 50
*    # or fetch older windows (ISO date is accepted):
*    npx tsx scripts/enqueue-trendyol-qna-sync.ts --connectionId <id> --startIso "2020-01-01" --endIso "2020-01-15" --status ANSWERED --pageSize 50
 * 2) Legacy positional (kept for compatibility):
 *    npx tsx scripts/enqueue-trendyol-qna-sync.ts WAITING_FOR_ANSWER 50
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

type Flags = {
  connectionId?: string;
  days?: number;
  status?: string;
  pageSize?: number;
  startDate?: number; // epoch ms (also accepts ISO date strings via Date.parse)
  endDate?: number; // epoch ms (also accepts ISO date strings via Date.parse)
};

function parseDateLike(v: string): number {
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  if (/^\d{13,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function parseArgs(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a.startsWith("--")) {
      const [kRaw, vRaw] = a.split("=", 2);
      const k = kRaw.replace(/^--/, "").trim();

      // value can be either in --k=v or as the next token, BUT only if the next token is not another flag
      let v: string | undefined = vRaw;
      if (v == null) {
        const next = argv[i + 1];
        if (typeof next === "string" && next.length && !next.startsWith("--")) {
          v = next;
          i++;
        }
      }

      const val = (v ?? "").toString().trim();

      if (k === "connectionId") flags.connectionId = val;
      else if (k === "status") flags.status = val;
      else if (k === "days") flags.days = Number(val);
      else if (k === "pageSize") flags.pageSize = Number(val);
      else if (k === "startDate") flags.startDate = parseDateLike(val);
      else if (k === "endDate") flags.endDate = parseDateLike(val);
      else if (k === "startIso") flags.startDate = parseDateLike(val);
      else if (k === "endIso") flags.endDate = parseDateLike(val);

      continue;
    }

    positional.push(a);
  }

  return { flags, positional };
}

function clampWindow(startMs: number, endMs: number) {
  const MAX_MS = 14 * 24 * 60 * 60 * 1000;

  let endDate = Number.isFinite(endMs) ? endMs : Date.now();
  let startDate = Number.isFinite(startMs) ? startMs : endDate - MAX_MS;

  if (endDate < startDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }

  let clamped = false;
  if (endDate - startDate > MAX_MS) {
    startDate = endDate - MAX_MS;
    clamped = true;
  }

  return { startDate, endDate, clamped };
}

async function main() {
  loadEnv();

  const { flags, positional } = parseArgs(process.argv.slice(2));

  // legacy positional: [status] [pageSize]
  const statusPos = (positional[0] ?? "").trim();
  const pageSizePos = positional[1] != null ? Number(positional[1]) : NaN;

  const status = String(flags.status ?? statusPos ?? "WAITING_FOR_ANSWER").trim() || "WAITING_FOR_ANSWER";
  const pageSizeRaw = Number(flags.pageSize ?? pageSizePos ?? 50);
  const pageSize = Math.min(Math.max(Number.isFinite(pageSizeRaw) ? pageSizeRaw : 50, 1), 50);

  const prisma = new PrismaClient();
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("eci-jobs", { connection: redis });

  try {
    // connectionId resolution order:
    // 1) --connectionId flag
    // 2) CONNECTION_ID env
    // 3) most recent active trendyol connection
    const explicitId = (flags.connectionId ?? process.env.CONNECTION_ID ?? "").trim();
    const conn = explicitId
      ? await prisma.connection.findUnique({
          where: { id: explicitId },
          select: { id: true, type: true, status: true },
        })
      : await prisma.connection.findFirst({
          where: { type: "trendyol", status: "active" },
          orderBy: { createdAt: "desc" },
          select: { id: true, type: true, status: true },
        });

    if (!conn) {
      throw new Error("No active Trendyol connection found. Pass --connectionId or set CONNECTION_ID.");
    }
    if (conn.type !== "trendyol") {
      throw new Error(`Connection type is not trendyol: ${conn.type}`);
    }

    const connectionId = conn.id;

    // Date window:
    // - If startDate & endDate are both provided => use them (clamped to 14d)
    // - Else use --days (default 14) ending at now (clamped)
    const now = Date.now();
    const days = Number.isFinite(Number(flags.days)) ? Math.max(1, Number(flags.days)) : 14;

    const endRaw = Number.isFinite(Number(flags.endDate)) ? Number(flags.endDate) : now;
    const startRaw =
      Number.isFinite(Number(flags.startDate))
        ? Number(flags.startDate)
        : endRaw - days * 24 * 60 * 60 * 1000;

    const { startDate, endDate, clamped } = clampWindow(startRaw, endRaw);

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
      { jobId: jobRow.id, connectionId, params: { status, pageSize, startDate, endDate } },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      }
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          jobId: jobRow.id,
          connectionId,
          params: {
            status,
            pageSize,
            startDate,
            endDate,
            clamped,
            startIso: new Date(startDate).toISOString(),
            endIso: new Date(endDate).toISOString(),
          },
        },
        null,
        2
      )
    );
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
