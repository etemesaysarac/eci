import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Robust .env loading for Windows/tsx: try current working dir, then parent dirs.
// This prevents scheduler env (SCHEDULER_EVERY_MS / SCHEDULER_ENABLED) from silently defaulting to 0/false.
(() => {
  // Load .env from multiple possible locations.
  // We intentionally load *all* existing candidates from repo root -> current dir,
  // so that a stale/partial .env in services/core does not hide scheduler vars in repo root.
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../.env"),
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(process.cwd(), "../../../.env"),
  ];

  const existing = candidates.filter((p) => fs.existsSync(p));
  if (existing.length === 0) {
    console.log(`[eci-worker] .env not found (cwd=${process.cwd()})`);
    return;
  }

  // Load from farthest parent to closest (root -> cwd). Closest wins for overlapping keys.
  const toLoad = [...new Set(existing)].reverse();

  for (const p of toLoad) {
    const res = dotenv.config({ path: p, override: true });
    const n = res.parsed ? Object.keys(res.parsed).length : 0;
    console.log(`[eci-worker] loaded .env from ${p} (keys=${n}, override=true)`);
  }
})();


import { randomUUID } from "crypto";

import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "./prisma";
import { computeSyncWindow } from "./sync/window";
import { decryptJson } from "./lib/crypto";
import {
  trendyolGetOrders,
  type OrdersQuery,
  type TrendyolConfig,
} from "./connectors/trendyol/client";

process.on("unhandledRejection", (e: unknown) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e: unknown) => console.error("[uncaughtException]", e));

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const SYNC_LOCK_TTL_MS = Number(process.env.SYNC_LOCK_TTL_MS ?? 60 * 60 * 1000);

function numEnv(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

// Sprint 5 incremental sync window config
const ECI_SYNC_OVERLAP_MINUTES = numEnv("ECI_SYNC_OVERLAP_MINUTES", 15);
const ECI_SYNC_SAFETY_DELAY_MINUTES = numEnv("ECI_SYNC_SAFETY_DELAY_MINUTES", 2);
const ECI_SYNC_BOOTSTRAP_HOURS = numEnv("ECI_SYNC_BOOTSTRAP_HOURS", 24);
const ECI_SYNC_MAX_WINDOW_DAYS = numEnv("ECI_SYNC_MAX_WINDOW_DAYS", 14);

// Sprint 6: scheduler only-due
const ECI_SCHEDULER_MIN_INTERVAL_MS = numEnv("ECI_SCHEDULER_MIN_INTERVAL_MS", 5 * 60 * 1000);

// Sprint 5 scheduler config (interval-based)
const SCHEDULER_EVERY_MS = numEnv("SCHEDULER_EVERY_MS", 0);
const SCHEDULER_ENABLED =
  (process.env.SCHEDULER_ENABLED ?? "").toLowerCase() === "true" ||
  (SCHEDULER_EVERY_MS > 0 && process.env.SCHEDULER_ENABLED == null);



function syncLockKey(connectionId: string) {
  return `eci:sync:lock:${connectionId}`;
}

async function refreshSyncLock(connectionId: string, jobId: string) {
  try {
    const key = syncLockKey(connectionId);
    const cur = await redis.get(key);
    if (cur === jobId) await redis.pexpire(key, SYNC_LOCK_TTL_MS);
  } catch {
    // ignore lock refresh errors
  }
}

async function releaseSyncLock(connectionId: string, jobId: string) {
  const key = syncLockKey(connectionId);
  const lua = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;
  try {
    await redis.eval(lua, 1, key, jobId);
  } catch {
    // ignore
  }
}

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const eciQueue = new Queue("eci-jobs", { connection: redis });


type JobData = {
  connectionId: string;
  jobId: string;
  params?: {
    status?: string;
    startDate?: number;
    endDate?: number;
    pageSize?: number;
  } | null;
};

function nowIso() {
  return new Date().toISOString();
}

function log(msg: string, meta?: Record<string, unknown>) {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[eci-worker] ${nowIso()} ${msg}${suffix}`);
}

// -----------------------------------------------------------------------------
// Scheduler (Sprint 5) - automatically enqueue incremental sync jobs on interval
// -----------------------------------------------------------------------------

type EnqueueResult =
  | { enqueued: true; jobId: string }
  | { enqueued: false; reason: "sync_in_progress" | "error"; error?: string };

async function compareDel(key: string, expectedValue: string) {
  // Delete key only if it still matches expectedValue (avoid killing another owner lock)
  const lua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await redis.eval(lua, 1, key, expectedValue);
}

async function enqueueTrendyolSyncOrders(
  connectionId: string,
  params: JobData["params"] = null
): Promise<EnqueueResult> {
  const lockKey = syncLockKey(connectionId);
  const pending = `pending:${randomUUID()}`;

  // Acquire lock (same semantics as API endpoint)
  const acquired = await redis.set(lockKey, pending, "PX", SYNC_LOCK_TTL_MS, "NX");
  if (acquired !== "OK") return { enqueued: false, reason: "sync_in_progress" };

  let jobRow: { id: string } | null = null;
  try {
    jobRow = await prisma.job.create({
      data: {
        connectionId,
        type: "TRENDYOL_SYNC_ORDERS",
        status: "queued",
      },
      select: { id: true },
    });

    // lock owner'ı gerçek jobId yapalım (worker release edebilsin)
    await redis.set(lockKey, jobRow.id, "PX", SYNC_LOCK_TTL_MS);

    await eciQueue.add(
      "TRENDYOL_SYNC_ORDERS",
      { jobId: jobRow.id, connectionId, params: params ?? null },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      }
    );

    return { enqueued: true, jobId: jobRow.id };
  } catch (e: any) {
    const errMsg = String(e?.message ?? e);

    if (jobRow?.id) {
      try {
        await prisma.job.update({
          where: { id: jobRow.id },
          data: { status: "failed", finishedAt: new Date(), error: errMsg },
        });
      } catch {
        // ignore
      }
    }

    // Release lock (either still pending, or already switched to jobRow.id)
    try {
      await compareDel(lockKey, jobRow?.id ?? pending);
    } catch {
      // ignore
    }

    return { enqueued: false, reason: "error", error: errMsg };
  }
}

let schedulerTickRunning = false;

async function schedulerTick() {
  if (schedulerTickRunning) return;
  schedulerTickRunning = true;
  const startedAt = Date.now();

  try {
    const conns = await prisma.connection.findMany({
      // Backward-compat: eski DB'lerde status="enabled" kalmis olabilir.
      where: { type: "trendyol", status: { in: ["active", "enabled"] } },
      select: { id: true },
    });

    log("scheduler tick", { connections: conns.length, everyMs: SCHEDULER_EVERY_MS, minIntervalMs: ECI_SCHEDULER_MIN_INTERVAL_MS });

    for (const c of conns) {
      // Sprint 6: only-due filter (avoid aggressive polling)
      const st = await prisma.syncState.findUnique({
        where: { connectionId: c.id },
        select: { lastAttemptAt: true },
      });
      if (st?.lastAttemptAt) {
        const agoMs = Date.now() - new Date(st.lastAttemptAt).getTime();
        if (agoMs < ECI_SCHEDULER_MIN_INTERVAL_MS) {
          log("scheduler skipped (only_due)", { connectionId: c.id, lastAttemptAgoMs: agoMs });
          continue;
        }
      }

      const r = await enqueueTrendyolSyncOrders(c.id, null);
      if (r.enqueued) {
        log("scheduler enqueued TRENDYOL_SYNC_ORDERS", { connectionId: c.id, jobId: r.jobId });
      } else if (r.reason === "sync_in_progress") {
        log("scheduler skipped (sync_in_progress)", { connectionId: c.id });
      } else {
        log("scheduler enqueue failed", { connectionId: c.id, error: r.error });
      }
    }
  } catch (e: any) {
    log("scheduler tick error", { error: String(e?.message ?? e) });
  } finally {
    schedulerTickRunning = false;
    log("scheduler tick done", { durationMs: Date.now() - startedAt });
  }
}

function startScheduler() {
  if (!SCHEDULER_ENABLED || SCHEDULER_EVERY_MS <= 0) {
    log("scheduler disabled", { SCHEDULER_ENABLED, SCHEDULER_EVERY_MS });
    return;
  }

  log("scheduler enabled", { everyMs: SCHEDULER_EVERY_MS, minIntervalMs: ECI_SCHEDULER_MIN_INTERVAL_MS });

  // Run once on boot, then on interval
  void schedulerTick();
  const t = setInterval(() => void schedulerTick(), SCHEDULER_EVERY_MS);
  (t as any).unref?.();
}

function parseHttpStatusFromErrorMessage(msg: string): number | null {
  // client.ts: "Trendyol shipment-packages failed (429) ..."
  const m = msg.match(/\((\d{3})\)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function shouldRetry(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  const code = parseHttpStatusFromErrorMessage(msg);
  if (!code) return false;
  if (code === 429) return true;
  if (code >= 500 && code < 600) return true;
  // 401/403 gibi durumları retry etmiyoruz; genelde credential/header/WAF problemdir
  return false;
}

function normalizeConfig(cfg: TrendyolConfig): TrendyolConfig {
  const sellerId = String(cfg.sellerId ?? "").trim();
  const tokenRaw = cfg.token != null ? String(cfg.token).trim() : undefined;
  const apiKey = cfg.apiKey != null ? String(cfg.apiKey).trim() : undefined;
  const apiSecret = cfg.apiSecret != null ? String(cfg.apiSecret).trim() : undefined;

  return {
    ...cfg,
    sellerId,
    token: tokenRaw ? tokenRaw.replace(/^Basic\s+/i, "").trim() : undefined,
    apiKey,
    apiSecret,
    agentName: String(cfg.agentName ?? "SoXYZ").trim(),
    integrationName: String(cfg.integrationName ?? "SoXYZ-ECI").trim(),
  };
}

async function syncOrders(connectionId: string, cfg: TrendyolConfig, params?: JobData["params"]) {
  const now = Date.now();
  const pageSize = params?.pageSize ?? 50;

  // Sprint 4: idempotency kanıtı ve "gerçek insert" ölçümü.
  // upserted sayacı şu an "işlenen" kayıt sayısı; insert/update ayrımı yapmıyor.
  // Bu yüzden sync öncesi/sonrası toplam kayıt sayısını ölçüyoruz.
  const countBefore = await prisma.order.count({
    where: { connectionId },
  });

  // Trendyol dokümantasyonunda startDate/endDate ile maksimum aralık 2 hafta.
  // Daha büyük aralık gelirse otomatik olarak 14 günlük pencerelere bölüyoruz.
  const MAX_WINDOW_MS = 14 * 24 * 3600 * 1000;

  const endDate = typeof params?.endDate === "number" ? params!.endDate : now;
  const startDate = typeof params?.startDate === "number" ? params!.startDate : endDate - 7 * 24 * 3600 * 1000;

  const status = (params?.status ?? "Created");

  if (!Number.isFinite(startDate) || !Number.isFinite(endDate)) {
    throw new Error("startDate/endDate must be unix epoch milliseconds");
  }
  if (startDate >= endDate) {
    throw new Error(`invalid date range: startDate(${startDate}) >= endDate(${endDate})`);
  }

  // Windows
  const windows: Array<{ start: number; end: number }> = [];
  let cursor = startDate;
  while (cursor < endDate) {
    const wEnd = Math.min(endDate, cursor + MAX_WINDOW_MS);
    windows.push({ start: cursor, end: wEnd });
    cursor = wEnd;
  }

  let upserted = 0;
  let shipUpserted = 0;
  let fetched = 0;
  let requestedPages = 0;

  log("syncOrders started", {
    connectionId,
    status,
    startDate,
    endDate,
    pageSize,
    windows: windows.length,
  });

  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];

    let page = 0;
    let totalPages: number | null = null;

    log("syncOrders window started", {
      connectionId,
      window: w + 1,
      windows: windows.length,
      startDate: win.start,
      endDate: win.end,
      status,
      pageSize,
    });

    while (totalPages === null || page < totalPages) {
      const q: OrdersQuery = {
        status,
        page,
        size: pageSize,
        startDate: win.start,
        endDate: win.end,
        // orders endpoint'te orderByField destekleniyorsa iyi; desteklenmiyorsa server 400 döndürür.
        // Bu yüzden opsiyonel bırakalım: (varsayılan sıralama Trendyol tarafında olur)
        // orderByField: "PackageLastModifiedDate",
        // orderByDirection: "DESC",
      };

      const data: any = await trendyolGetOrders(cfg, q);
      requestedPages++;

      // Trendyol genelde { content, totalPages, ... } döner.
      const items: any[] =
        Array.isArray(data)
          ? data
          : Array.isArray(data?.content)
            ? data.content
            : Array.isArray(data?.orders)
              ? data.orders
              : [];

      if (typeof data?.totalPages === "number") totalPages = data.totalPages;
      if (typeof data?.pageCount === "number") totalPages = data.pageCount;

      fetched += items.length;

      for (const it of items) {
        const marketplace = "trendyol";
        const channelOrderId = String(
          it?.orderNumber ?? it?.orderId ?? it?.id ?? it?.shipmentPackageId ?? it?.packageId ?? ""
        );
        if (!channelOrderId) continue;

        await prisma.order.upsert({
          where: {
            connectionId_marketplace_channelOrderId: {
              connectionId,
              marketplace,
              channelOrderId,
            },
          },
          create: { connectionId, marketplace, channelOrderId, raw: it },
          update: { raw: it },
        });

        upserted++;
        // Sprint 6: package-level idempotency
        const shipmentPackageId = it?.shipmentPackageId ?? it?.packageId ?? it?.id ?? null;
        if (shipmentPackageId != null && String(shipmentPackageId).trim() !== "") {
          await prisma.shipmentPackage.upsert({
            where: {
              connectionId_marketplace_shipmentPackageId: {
                connectionId,
                marketplace,
                shipmentPackageId: String(shipmentPackageId),
              },
            },
            create: { connectionId, marketplace, shipmentPackageId: String(shipmentPackageId), raw: it },
            update: { raw: it },
          });
          shipUpserted++;
        }

      }

      log("page processed", {
        connectionId,
        window: w + 1,
        windows: windows.length,
        page,
        items: items.length,
        fetched,
        upserted,
        totalPages,
        shipUpserted,
      });

      if (totalPages === null && items.length < pageSize) break;

      page++;
      if (page > 1000) throw new Error("pagination safety break: page>1000");
    }

    log("syncOrders window finished", {
      connectionId,
      window: w + 1,
      windows: windows.length,
      startDate: win.start,
      endDate: win.end,
    });
  }

  log("syncOrders finished", {
    connectionId,
    fetched,
    upserted,
    shipUpserted,
    requestedPages,
    windows: windows.length,
  });

  const countAfter = await prisma.order.count({
    where: { connectionId },
  });

  const inserted = Math.max(0, countAfter - countBefore);
  const updatedOrExisting = Math.max(0, fetched - inserted);

  return {
    upserted, // processed
    fetched,
    inserted,
    updatedOrExisting,
    countBefore,
    countAfter,
    status,
    startDate,
    endDate,
    pageSize,
    windows: windows.length,
    requestedPages,
  };
}

const worker = new Worker(
  "eci-jobs",
  async (job: Job<JobData, any, string>) => {
    const { connectionId, jobId, params } = job.data as JobData;

    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    log("job received", {
      name: job.name,
      jobId,
      connectionId,
      attempt,
      maxAttempts,
    });

    // startedAt'i sadece ilk denemede set etmeye çalış
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "running",
        startedAt: attempt === 1 ? new Date() : undefined,
        finishedAt: null,
        error: null,
      },
    });
    await refreshSyncLock(connectionId, jobId);


    const attemptAt = new Date();

    // Sprint 5: ensure per-connection sync_state exists and mark RUNNING
    await prisma.syncState.upsert({
      where: { connectionId },
      create: {
        connectionId,
        lastAttemptAt: attemptAt,
        lastStatus: "RUNNING",
        lastJobId: jobId,
        lastError: null,
      },
      update: {
        lastAttemptAt: attemptAt,
        lastStatus: "RUNNING",
        lastJobId: jobId,
        lastError: null,
      },
    });

    // Determine sync window: manual params override; otherwise auto window from lastSuccessAt
    const state = await prisma.syncState.findUnique({
      where: { connectionId },
      select: { lastSuccessAt: true },
    });

const autoRaw: any = computeSyncWindow({
  lastSuccessAt: state?.lastSuccessAt ?? null,
  // bazı implementasyonlar `now` bekliyor; scheduler'da undefined kalmasın
  now: new Date(),
  overlapMinutes: ECI_SYNC_OVERLAP_MINUTES,
  safetyDelayMinutes: ECI_SYNC_SAFETY_DELAY_MINUTES,
  bootstrapHours: ECI_SYNC_BOOTSTRAP_HOURS,
  maxWindowDays: ECI_SYNC_MAX_WINDOW_DAYS,
} as any);

const fallbackEnd = Date.now() - ECI_SYNC_SAFETY_DELAY_MINUTES * 60_000;
const fallbackStart = fallbackEnd - ECI_SYNC_BOOTSTRAP_HOURS * 3600_000;

const autoStart =
  typeof autoRaw?.startDate === "number"
    ? autoRaw.startDate
    : autoRaw?.windowStart instanceof Date
      ? autoRaw.windowStart.getTime()
      : Number.isFinite(Number(autoRaw?.windowStart))
        ? Number(autoRaw.windowStart)
        : fallbackStart;

const autoEnd =
  typeof autoRaw?.endDate === "number"
    ? autoRaw.endDate
    : autoRaw?.windowEnd instanceof Date
      ? autoRaw.windowEnd.getTime()
      : Number.isFinite(Number(autoRaw?.windowEnd))
        ? Number(autoRaw.windowEnd)
        : fallbackEnd;

const auto = { startDate: autoStart, endDate: autoEnd };

    const hasManualStart = typeof params?.startDate === "number";
    const hasManualEnd = typeof params?.endDate === "number";

    const windowStart = hasManualStart ? (params!.startDate as number) : auto.startDate;
    const windowEnd = hasManualEnd ? (params!.endDate as number) : auto.endDate;

    const usedAutoWindow = !(hasManualStart || hasManualEnd);

    const effectiveParams: JobData["params"] = {
      ...(params ?? {}),
      startDate: windowStart,
      endDate: windowEnd,
    };

    const t0 = Date.now();

    try {
      const conn = await prisma.connection.findUnique({ where: { id: connectionId } });
      if (!conn) throw new Error("connection not found: " + connectionId);

      const cfg = normalizeConfig(decryptJson<TrendyolConfig>(conn.configEnc));

      let summary: any;
      switch (job.name) {
        case "TRENDYOL_SYNC_ORDERS":
          summary = await syncOrders(connectionId, cfg, effectiveParams ?? undefined);
          break;
        // Backward-compat: eski job adı.
        case "TRENDYOL_SYNC_SHIPMENT_PACKAGES":
          summary = await syncOrders(connectionId, cfg, effectiveParams ?? undefined);
          break;
        default:
          throw new Error(`unknown job: ${job.name}`);
      }


      const durationMs = Date.now() - t0;

      summary = {
        ...summary,
        windowStart: new Date(windowStart).toISOString(),
        windowEnd: new Date(windowEnd).toISOString(),
        durationMs,
        usedAutoWindow,
        overlapMinutes: ECI_SYNC_OVERLAP_MINUTES,
        safetyDelayMinutes: ECI_SYNC_SAFETY_DELAY_MINUTES,
      };

      // Sprint 5: update lastSuccessAt only on SUCCESS
      await prisma.syncState.upsert({
        where: { connectionId },
        create: {
          connectionId,
          lastSuccessAt: new Date(),
          lastStatus: "SUCCESS",
          lastJobId: jobId,
          lastError: null,
          lastAttemptAt: attemptAt,
        },
        update: {
          lastSuccessAt: new Date(),
          lastStatus: "SUCCESS",
          lastJobId: jobId,
          lastError: null,
        },
      });

      log("SYNC_SUMMARY", {
        connectionId,
        jobId,
        windowStart: summary.windowStart,
        windowEnd: summary.windowEnd,
        fetched: (summary as any)?.fetched,
        upserted: (summary as any)?.upserted,
        inserted: (summary as any)?.inserted,
        shipUpserted: (summary as any)?.shipUpserted,
        durationMs,
        usedAutoWindow,
      });

      await prisma.job.update({
        where: { id: jobId },
        data: { status: "success", finishedAt: new Date(), summary, error: null },
      });
      await releaseSyncLock(connectionId, jobId);

      log("job success", { name: job.name, jobId, connectionId, summary });
      return summary;
    } catch (err: any) {
      const retrying = shouldRetry(err) && attempt < maxAttempts;

      // Sprint 5: mark state as RETRYING/FAIL. Use upsert to avoid "record not found" errors.
      await prisma.syncState.upsert({
        where: { connectionId },
        create: {
          connectionId,
          lastAttemptAt: new Date(),
          lastStatus: retrying ? "RETRYING" : "FAIL",
          lastJobId: jobId,
          lastError: String(err?.message ?? err),
        },
        update: {
          lastAttemptAt: new Date(),
          lastStatus: retrying ? "RETRYING" : "FAIL",
          lastJobId: jobId,
          lastError: String(err?.message ?? err),
        },
      });

      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: retrying ? "retrying" : "failed",
          finishedAt: retrying ? null : new Date(),
          error: String(err?.message ?? err),
        },
      });

      log("job error", {
        name: job.name,
        jobId,
        connectionId,
        retrying,
        attempt,
        maxAttempts,
        error: String(err?.message ?? err),
      });

      // ÖNEMLİ:
      // - retrying ise throw ederek BullMQ'nun bir sonraki denemeyi planlamasını sağlarız
      // - retrying değilse throw ETMEYİZ: 401/403 gibi credential hatalarında BullMQ tekrar tekrar vurmasın
      if (!retrying) await releaseSyncLock(connectionId, jobId);
      if (retrying) throw err;
      return { failed: true, error: String(err?.message ?? err) };
    }
  },
  { connection: redis }
);

worker.on("completed", (job) => {
  log("completed event", {
    name: job.name,
    jobId: (job.data as any)?.jobId,
    connectionId: (job.data as any)?.connectionId,
  });
});

worker.on("failed", (job, err) => {
  log("failed event", {
    name: job?.name,
    jobId: (job?.data as any)?.jobId,
    connectionId: (job?.data as any)?.connectionId,
    error: String((err as any)?.message ?? err),
  });
});

startScheduler();

log(`pid=${process.pid} listening for jobs on queue: eci-jobs (${REDIS_URL})`);