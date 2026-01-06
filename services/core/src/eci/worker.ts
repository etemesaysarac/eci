import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Single-source .env loading (Sprint 7.1):
// - If ECI_ENV_FILE is set, load that exact file.
// - Otherwise load ".env" from the current working directory.
// This removes ambiguity caused by loading multiple .env files with override=true.
(() => {
  const explicit = (process.env.ECI_ENV_FILE ?? "").trim();
  const p = explicit ? path.resolve(explicit) : path.resolve(process.cwd(), ".env");

  if (!fs.existsSync(p)) {
    console.log(`[eci-worker] .env not found at ${p} (cwd=${process.cwd()})`);
    return;
  }

  const res = dotenv.config({ path: p, override: true });
  const n = res.parsed ? Object.keys(res.parsed).length : 0;
  console.log(`[eci-worker] loaded .env from ${p} (keys=${n}, override=true)`);
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

  // Sync params (polling/scheduler/manual)
  params?: {
    status?: string;
    startDate?: number;
    endDate?: number;
    pageSize?: number;
  } | null;

  // Sprint 8: webhook raw event (receiver -> worker)
  webhook?: {
    provider: string;
    payload: any;
  } | null;

  // Sprint 8: targeted sync hints (webhook event -> targeted job)
  target?: {
    orderNumber?: string;
    shipmentPackageId?: string;
    status?: string;
    windowMinutes?: number;
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
    agentName: String(cfg.agentName ?? process.env.TRENDYOL_AGENT_NAME ?? "Easyso").trim(),
    integrationName: String(cfg.integrationName ?? process.env.TRENDYOL_INTEGRATION_NAME ?? "ECI").trim(),
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



const SYNC_JOB_NAMES = new Set([
  "TRENDYOL_SYNC_ORDERS",
  "TRENDYOL_SYNC_SHIPMENT_PACKAGES", // backward-compat
  "TRENDYOL_SYNC_ORDERS_TARGETED",
]);

function isSyncJob(name: string) {
  return SYNC_JOB_NAMES.has(name);
}

function shouldRetryForJob(jobName: string, err: unknown): boolean {
  if (jobName === "TRENDYOL_WEBHOOK_EVENT") return true; // transient DB/redis issues can happen
  return shouldRetry(err);
}

function normalizeStatusForOrders(status?: string): string {
  const s = (status ?? "").trim();
  if (!s) return "Created";

  // Trendyol orders endpoint expects e.g. Created / Picking / Invoiced / Shipped / Delivered / Cancelled / Returned ...
  // If webhook sends lowercase/enum-like, normalize gently.
  const map: Record<string, string> = {
    created: "Created",
    picking: "Picking",
    invoiced: "Invoiced",
    shipped: "Shipped",
    delivered: "Delivered",
    cancelled: "Cancelled",
    returned: "Returned",
    undefined: "Created",
  };

  const k = s.toLowerCase();
  return map[k] ?? s;
}

function parseWebhookTarget(payload: any): { orderNumber?: string; shipmentPackageId?: string; status?: string } {
  // Keep this permissive; we just want to derive a best-effort target.
  const orderNumber =
    payload?.orderNumber ??
    payload?.orderNo ??
    payload?.orderId ??
    payload?.data?.orderNumber ??
    payload?.data?.orderNo ??
    payload?.data?.orderId ??
    null;

  const shipmentPackageId =
    payload?.shipmentPackageId ??
    payload?.packageId ??
    payload?.shipmentId ??
    payload?.data?.shipmentPackageId ??
    payload?.data?.packageId ??
    payload?.data?.shipmentId ??
    null;

  const status =
    payload?.status ??
    payload?.shipmentStatus ??
    payload?.orderStatus ??
    payload?.data?.status ??
    payload?.data?.shipmentStatus ??
    payload?.data?.orderStatus ??
    null;

  return {
    orderNumber: orderNumber != null ? String(orderNumber) : undefined,
    shipmentPackageId: shipmentPackageId != null ? String(shipmentPackageId) : undefined,
    status: status != null ? String(status) : undefined,
  };
}

type TargetSync = {
  orderNumber?: string;
  shipmentPackageId?: string;
  status?: string;
  windowMinutes?: number;
};

async function enqueueTrendyolSyncOrdersTargeted(connectionId: string, target: TargetSync): Promise<EnqueueResult> {
  const lockKey = syncLockKey(connectionId);
  const pending = `pending:${randomUUID()}`;

  const acquired = await redis.set(lockKey, pending, "PX", SYNC_LOCK_TTL_MS, "NX");
  if (acquired !== "OK") return { enqueued: false, reason: "sync_in_progress" };

  let jobRow: { id: string } | null = null;
  try {
    jobRow = await prisma.job.create({
      data: {
        connectionId,
        type: "TRENDYOL_SYNC_ORDERS_TARGETED",
        status: "queued",
      },
      select: { id: true },
    });

    await redis.set(lockKey, jobRow.id, "PX", SYNC_LOCK_TTL_MS);

    await eciQueue.add(
      "TRENDYOL_SYNC_ORDERS_TARGETED",
      { jobId: jobRow.id, connectionId, target },
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

    try {
      await compareDel(lockKey, jobRow?.id ?? pending);
    } catch {
      // ignore
    }

    return { enqueued: false, reason: "error", error: errMsg };
  }
}

const worker = new Worker(
  "eci-jobs",
  async (job: Job<JobData, any, string>) => {
    const { connectionId, jobId, params, webhook, target } = job.data as JobData;

    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    log("job received", {
      name: job.name,
      jobId,
      connectionId,
      attempt,
      maxAttempts,
    });

    const isSync = isSyncJob(job.name);

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

    // Lock refresh only matters for sync jobs (scheduler/targeted)
    if (isSync) {
      await refreshSyncLock(connectionId, jobId);
    }

    const attemptAt = new Date();

    if (isSync) {
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
    }

    const t0 = Date.now();

    try {
      const conn = await prisma.connection.findUnique({ where: { id: connectionId } });
      if (!conn) throw new Error("connection not found: " + connectionId);

      const cfg = normalizeConfig(decryptJson<TrendyolConfig>(conn.configEnc));

      let summary: any = null;

      switch (job.name) {
        case "TRENDYOL_SYNC_ORDERS":
        case "TRENDYOL_SYNC_SHIPMENT_PACKAGES": {
          // Determine sync window: manual params override; otherwise auto window from lastSuccessAt
          const state = await prisma.syncState.findUnique({
            where: { connectionId },
            select: { lastSuccessAt: true },
          });

          const autoRaw: any = computeSyncWindow({
            lastSuccessAt: state?.lastSuccessAt ?? null,
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

          const hasManualStart = typeof params?.startDate === "number";
          const hasManualEnd = typeof params?.endDate === "number";

          const windowStart = hasManualStart ? (params!.startDate as number) : autoStart;
          const windowEnd = hasManualEnd ? (params!.endDate as number) : autoEnd;

          const usedAutoWindow = !(hasManualStart || hasManualEnd);

          const effectiveParams: JobData["params"] = {
            ...(params ?? {}),
            startDate: windowStart,
            endDate: windowEnd,
          };

          summary = await syncOrders(connectionId, cfg, effectiveParams ?? undefined);

          summary = {
            ...summary,
            windowStart: new Date(windowStart).toISOString(),
            windowEnd: new Date(windowEnd).toISOString(),
            durationMs: Date.now() - t0,
            usedAutoWindow,
            overlapMinutes: ECI_SYNC_OVERLAP_MINUTES,
            safetyDelayMinutes: ECI_SYNC_SAFETY_DELAY_MINUTES,
          };

          break;
        }

        case "TRENDYOL_WEBHOOK_EVENT": {
          const payload = (webhook as any)?.payload ?? null;
          const derived = parseWebhookTarget(payload);

          // Audit note: if we cannot derive any target identifiers, we still enqueue a normal targeted sync with a wide window.
          const windowMinutes = Number(process.env.ECI_WEBHOOK_TARGET_WINDOW_MINUTES ?? 10080); // default 7 days

          const r = await enqueueTrendyolSyncOrdersTargeted(connectionId, {
            ...derived,
            windowMinutes,
          });

          summary = {
            provider: (webhook as any)?.provider ?? "TRENDYOL",
            derivedTarget: derived,
            windowMinutes,
            enqueued: r.enqueued,
            nextJobId: (r as any).jobId ?? null,
            reason: (r as any).reason ?? null,
            durationMs: Date.now() - t0,
          };

          break;
        }

        case "TRENDYOL_SYNC_ORDERS_TARGETED": {
          const t: TargetSync = (target ?? {}) as any;

          const windowMinutes = Number(t.windowMinutes ?? process.env.ECI_WEBHOOK_TARGET_WINDOW_MINUTES ?? 10080); // default 7 days
          const endDate = Date.now();
          const startDate = endDate - Math.max(5, windowMinutes) * 60_000;

          const effectiveParams: JobData["params"] = {
            ...(params ?? {}),
            status: normalizeStatusForOrders(t.status),
            startDate,
            endDate,
          };

          summary = await syncOrders(connectionId, cfg, effectiveParams ?? undefined);

          summary = {
            ...summary,
            targeted: true,
            target: {
              orderNumber: t.orderNumber ?? null,
              shipmentPackageId: t.shipmentPackageId ?? null,
              status: normalizeStatusForOrders(t.status),
              windowMinutes,
            },
            windowStart: new Date(startDate).toISOString(),
            windowEnd: new Date(endDate).toISOString(),
            durationMs: Date.now() - t0,
          };

          break;
        }

        default:
          throw new Error(`unknown job: ${job.name}`);
      }

      // Success path
      if (isSync) {
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
          fetched: (summary as any)?.fetched,
          upserted: (summary as any)?.upserted,
          inserted: (summary as any)?.inserted,
          shipUpserted: (summary as any)?.shipUpserted,
          durationMs: (summary as any)?.durationMs,
          targeted: (summary as any)?.targeted ?? false,
        });
      }

      await prisma.job.update({
        where: { id: jobId },
        data: { status: "success", finishedAt: new Date(), summary, error: null },
      });

      if (isSync) {
        await releaseSyncLock(connectionId, jobId);
      }

      log("job success", { name: job.name, jobId, connectionId });
      return summary;
    } catch (err: any) {
      const retrying = shouldRetryForJob(job.name, err) && attempt < maxAttempts;

      if (isSync) {
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
      }

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

      // Retry policy:
      // - if retrying => throw to let BullMQ schedule next attempt
      // - if not retrying => do not throw (avoid hammering credentials/business errors)
      if (!retrying && isSync) await releaseSyncLock(connectionId, jobId);
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