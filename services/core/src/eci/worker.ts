import { Buffer } from "buffer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
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
  trendyolGetClaims,
  trendyolApproveClaimLineItems,
  trendyolCreateClaimIssue,
  trendyolGetClaimAudits,
  trendyolCreateClaim,
  trendyolListApprovedProducts,
  trendyolListUnapprovedProducts,
  trendyolCreateProducts,
  trendyolUpdateProducts,
  trendyolUpdatePriceAndInventory,
  trendyolQnaQuestionsFilter,
  trendyolQnaQuestionById,
  trendyolQnaCreateAnswer,
  type OrdersQuery,
  type ClaimsQuery,
  type ProductsListQuery,
  type QnaQuestionsFilterQuery,
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
redis.on("error", (e: any) => {
  const msg = e?.message ?? String(e);
  console.error("[redis:error]", msg);
});
redis.on("connect", () => console.log("[redis] connect"));
redis.on("ready", () => console.log("[redis] ready"));

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

  // Sprint 9: product push (API -> worker)
  push?: { action?: "create" | "update" } | null;
  payload?: any | null;
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
    agentName: String(cfg.agentName ?? "Easyso").trim(),
    integrationName: String(cfg.integrationName ?? "ECI").trim(),
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

function toDateMaybe(v: any): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === "number") {
    // Heuristic: seconds vs milliseconds
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function extractClaimItems(data: any): { items: any[]; totalPages: number | null } {
  const items: any[] =
    Array.isArray(data)
      ? data
      : Array.isArray(data?.content)
        ? data.content
        : Array.isArray(data?.claims)
          ? data.claims
          : Array.isArray(data?.items)
            ? data.items
            : [];

  const totalPages =
    typeof data?.totalPages === "number"
      ? data.totalPages
      : typeof data?.pageCount === "number"
        ? data.pageCount
        : typeof data?.totalPageCount === "number"
          ? data.totalPageCount
          : null;

  return { items, totalPages };
}

async function syncClaims(connectionId: string, cfg: TrendyolConfig, params?: JobData["params"]) {
  const now = Date.now();
  const pageSize = params?.pageSize ?? 50;

  const endDate = typeof params?.endDate === "number" ? params.endDate : now;
  const startDate = typeof params?.startDate === "number" ? params.startDate : endDate - 7 * 24 * 3600 * 1000;

  // Trendyol claims list supports claimItemStatus filter.
  const claimItemStatus = params?.status != null && String(params.status).trim().length ? String(params.status).trim() : undefined;

  log("syncClaims started", { connectionId, startDate, endDate, pageSize, claimItemStatus });

  const q: ClaimsQuery = {
    page: 0,
    size: pageSize,
    startDate,
    endDate,
    claimItemStatus,
  };

  const data: any = await trendyolGetClaims(cfg, q);
  const { items: claims } = extractClaimItems(data);

  let fetchedClaims = 0;
  let upsertedClaims = 0;
  let upsertedItems = 0;

  for (const claim of claims) {
    fetchedClaims++;

    const marketplace = "trendyol";
    const claimId = String(claim?.claimId ?? claim?.id ?? "").trim();
    if (!claimId) continue;

    const status = claim?.status != null ? String(claim.status) : null;
    const orderNumber = claim?.orderNumber != null ? String(claim.orderNumber) : null;
    const claimDate = toDateMaybe(claim?.claimDate ?? claim?.claimDateTime ?? claim?.createdDate);
    const lastModifiedAt = toDateMaybe(claim?.lastModifiedDate ?? claim?.lastModifiedAt ?? claim?.modifiedDate);

    const existingClaim = await prisma.claim.findFirst({
      where: { connectionId, marketplace, claimId },
      select: { id: true },
    });

    const claimDb = existingClaim
      ? await prisma.claim.update({
          where: { id: existingClaim.id },
          data: {
            status,
            orderNumber,
            claimDate,
            lastModifiedAt,
            raw: (claim ?? {}) as any,
          },
          select: { id: true },
        })
      : await prisma.claim.create({
          data: {
            connectionId,
            marketplace,
            claimId,
            status,
            orderNumber,
            claimDate,
            lastModifiedAt,
            raw: (claim ?? {}) as any,
          },
          select: { id: true },
        });

    upsertedClaims++;

    // Trendyol: claimLineItemIdList is guaranteed; sometimes full line items also exist.
    const lineItems: any[] =
      Array.isArray(claim?.claimLineItems)
        ? claim.claimLineItems
        : Array.isArray(claim?.claimItems)
          ? claim.claimItems
          : Array.isArray(claim?.items)
            ? claim.items
            : [];

    const idListRaw: any[] = Array.isArray(claim?.claimLineItemIdList) ? claim.claimLineItemIdList : [];

    const itemsToWrite = lineItems.length
      ? lineItems
      : idListRaw.map((id) => ({ claimLineItemId: id }));

    for (const li of itemsToWrite) {
      const claimItemId = String(li?.claimLineItemId ?? li?.claimItemId ?? li?.id ?? "").trim();
      if (!claimItemId) continue;

      const barcode = li?.barcode != null ? String(li.barcode) : null;
      const sku = li?.merchantSku != null ? String(li.merchantSku) : li?.sku != null ? String(li.sku) : null;
      const quantity = li?.quantity != null ? Number(li.quantity) : null;
      const itemStatus = li?.status != null ? String(li.status) : li?.claimItemStatus != null ? String(li.claimItemStatus) : null;

      const reasonCode = li?.reasonCode != null ? String(li.reasonCode) : li?.reasonId != null ? String(li.reasonId) : null;
      const reasonName = li?.reasonName != null ? String(li.reasonName) : li?.reason != null ? String(li.reason) : null;

      const existingItem = await prisma.claimItem.findFirst({
        where: { connectionId, marketplace, claimItemId },
        select: { id: true },
      });

      if (existingItem) {
        await prisma.claimItem.update({
          where: { id: existingItem.id },
          data: {
            claimDbId: claimDb.id,
            claimId,
            barcode,
            sku,
            quantity: quantity != null && Number.isFinite(quantity) ? Math.trunc(quantity) : null,
            itemStatus,
            reasonCode,
            reasonName,
            raw: (li ?? {}) as any,
          },
        });
      } else {
        await prisma.claimItem.create({
          data: {
            connectionId,
            marketplace,
            claimDbId: claimDb.id,
            claimId,
            claimItemId,
            barcode,
            sku,
            quantity: quantity != null && Number.isFinite(quantity) ? Math.trunc(quantity) : null,
            itemStatus,
            reasonCode,
            reasonName,
            raw: (li ?? {}) as any,
          },
        });
      }

      upsertedItems++;
    }
  }

  log("syncClaims finished", { connectionId, fetchedClaims, upsertedClaims, upsertedItems });

  return {
    fetchedClaims,
    upsertedClaims,
    upsertedItems,
    pageSize,
    claimItemStatus,
    startDate,
    endDate,
    requestedPages: 1,
  };
}
// Sprint 13: QnA — Questions sync (Trendyol -> DB)
// Step 4.1: Wire job + fetch first page (no DB upsert yet; Step 4.2 will add DB writes)
async function syncQnaQuestions(connectionId: string, cfg: TrendyolConfig, params?: JobData["params"]) {
  const pageSizeRaw = params?.pageSize ?? 50;
  const pageSize = Math.min(Math.max(Number(pageSizeRaw) || 50, 1), 50);

  const statusRaw = params?.status != null ? String(params.status).trim() : "";
  const status = statusRaw.length ? statusRaw : "WAITING_FOR_ANSWER";

  // supplierId is required by Trendyol for list/filter.
  // Source of truth order:
  //   1) TRENDYOL_SUPPLIER_ID env (explicit override)
  //   2) cfg.supplierId (persisted in connection config)
  //   3) client fallback to cfg.sellerId
  const supplierIdEnv = (process.env.TRENDYOL_SUPPLIER_ID ?? "").trim();
  const supplierIdCfg = String((cfg as any)?.supplierId ?? "").trim();
  const supplierId = supplierIdEnv.length ? supplierIdEnv : supplierIdCfg.length ? supplierIdCfg : undefined;

  const toDateMaybe = (v: any): Date | null => {
    const n = typeof v === "string" && v.trim().length ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return new Date(n);
    return null;
  };

  const startDateRaw = params?.startDate ?? params?.windowStart ?? undefined;
  const endDateRaw = params?.endDate ?? params?.windowEnd ?? undefined;
  let startDate = typeof startDateRaw === "number" ? startDateRaw : undefined;
  let endDate = typeof endDateRaw === "number" ? endDateRaw : undefined;

  // Trendyol.pdf: if start/end provided, max window is 2 weeks.
  if (typeof startDate === "number" && typeof endDate === "number" && endDate > startDate) {
    const MAX_MS = 14 * 24 * 60 * 60 * 1000;
    if (endDate - startDate > MAX_MS) startDate = endDate - MAX_MS;
  } else {
    startDate = undefined;
    endDate = undefined;
  }

  const q: QnaQuestionsFilterQuery = {
    supplierId,
    status,
    page: 0,
    size: pageSize,
    ...(startDate != null && endDate != null ? { startDate, endDate } : {}),
  };

  log("syncQnaQuestions started", {
    connectionId,
    status,
    pageSize,
    supplierId: supplierId ?? "(fallback)",
    supplierIdSource: supplierIdEnv.length ? "env" : supplierIdCfg.length ? "cfg" : "fallback_sellerId",
    ...(startDate != null && endDate != null
      ? { startDate: new Date(startDate).toISOString(), endDate: new Date(endDate).toISOString() }
      : {}),
  });

  const data: any = await trendyolQnaQuestionsFilter(cfg, q);

  const content: any[] = Array.isArray(data?.content) ? data.content : [];
  const totalElements = typeof data?.totalElements === "number" ? data.totalElements : content.length;
  const totalPages = typeof data?.totalPages === "number" ? data.totalPages : undefined;

  let questionsUpserted = 0;
  let answersUpserted = 0;

  // Step 4.2: Write only page-0 content (no pagination yet)
  for (const item of content) {
    const questionId = String(item?.id ?? item?.questionId ?? "").trim();
    if (!questionId) continue;

    const askedAt = toDateMaybe(item?.creationDate ?? item?.askedAt ?? item?.askedAtMillis);
    const lastModifiedAt =
      toDateMaybe(item?.lastModifiedDate ?? item?.lastModifiedAt ?? item?.updatedDate ?? item?.modifiedDate);

    const row = await prisma.question.upsert({
      where: {
        connectionId_marketplace_questionId: { connectionId, marketplace: "trendyol", questionId },
      },
      create: {
        connectionId,
        marketplace: "trendyol",
        questionId,
        status: String(item?.status ?? status ?? "").trim() || null,
        askedAt: askedAt ?? undefined,
        lastModifiedAt: lastModifiedAt ?? undefined,

        customerId: item?.customerId != null ? String(item.customerId) : item?.userId != null ? String(item.userId) : null,
        userName: item?.userName != null ? String(item.userName) : null,
        showUserName: typeof item?.showUserName === "boolean" ? item.showUserName : null,

        productName:
          item?.productName != null
            ? String(item.productName)
            : item?.product?.name != null
              ? String(item.product.name)
              : null,
        productMainId:
          item?.productMainId != null
            ? String(item.productMainId)
            : item?.product?.mainId != null
              ? String(item.product.mainId)
              : null,
        imageUrl:
          item?.productImageUrl != null
            ? String(item.productImageUrl)
            : item?.imageUrl != null
              ? String(item.imageUrl)
              : null,
        webUrl:
          item?.webUrl != null
            ? String(item.webUrl)
            : item?.productUrl != null
              ? String(item.productUrl)
              : null,

        text:
          item?.text != null
            ? String(item.text)
            : item?.questionText != null
              ? String(item.questionText)
              : null,

        raw: (item ?? {}) as any,
      },
      update: {
        status: String(item?.status ?? status ?? "").trim() || null,
        askedAt: askedAt ?? undefined,
        lastModifiedAt: lastModifiedAt ?? undefined,

        customerId: item?.customerId != null ? String(item.customerId) : item?.userId != null ? String(item.userId) : null,
        userName: item?.userName != null ? String(item.userName) : null,
        showUserName: typeof item?.showUserName === "boolean" ? item.showUserName : null,

        productName:
          item?.productName != null
            ? String(item.productName)
            : item?.product?.name != null
              ? String(item.product.name)
              : null,
        productMainId:
          item?.productMainId != null
            ? String(item.productMainId)
            : item?.product?.mainId != null
              ? String(item.product.mainId)
              : null,
        imageUrl:
          item?.productImageUrl != null
            ? String(item.productImageUrl)
            : item?.imageUrl != null
              ? String(item.imageUrl)
              : null,
        webUrl:
          item?.webUrl != null
            ? String(item.webUrl)
            : item?.productUrl != null
              ? String(item.productUrl)
              : null,

        text:
          item?.text != null
            ? String(item.text)
            : item?.questionText != null
              ? String(item.questionText)
              : null,

        raw: (item ?? {}) as any,
      },
    });

    questionsUpserted += 1;

    const ans = item?.answer ?? null;
    const answerText = ans?.text != null ? String(ans.text).trim() : ans?.answerText != null ? String(ans.answerText).trim() : "";
    if (answerText.length) {
      const answeredAt = toDateMaybe(ans?.creationDate ?? ans?.answeredAt ?? ans?.answeredAtMillis);

      await prisma.answer.upsert({
        where: {
          connectionId_marketplace_questionId: { connectionId, marketplace: "trendyol", questionId },
        },
        create: {
          connectionId,
          marketplace: "trendyol",
          questionDbId: row.id,
          questionId,
          answerText,
          answeredAt: answeredAt ?? undefined,
          executorApp: ans?.executorApp != null ? String(ans.executorApp) : null,
          executorUser: ans?.executorUser != null ? String(ans.executorUser) : null,
          raw: (ans ?? {}) as any,
        },
        update: {
          answerText,
          answeredAt: answeredAt ?? undefined,
          executorApp: ans?.executorApp != null ? String(ans.executorApp) : null,
          executorUser: ans?.executorUser != null ? String(ans.executorUser) : null,
          raw: (ans ?? {}) as any,
        },
      });

      answersUpserted += 1;
    }
  }

  const summary = {
    ok: true,
    mode: "write",
    connectionId,
    status,
    page: typeof data?.page === "number" ? data.page : 0,
    size: typeof data?.size === "number" ? data.size : pageSize,
    totalElements,
    totalPages,
    fetched: content.length,
    questionsUpserted,
    answersUpserted,
    firstIds: content
      .slice(0, 3)
      .map((x) => String(x?.id ?? x?.questionId ?? "").trim())
      .filter(Boolean),
  };

  log("syncQnaQuestions done", summary);
  return summary;
}






async function finishQnaCommand(commandId: string | null | undefined, data: { status: string; response?: any; error?: any }) {
  if (!commandId) return;
  const errMsg = data.error ? String((data.error as any)?.message ?? data.error) : null;
  await prisma.qnaCommand
    .update({
      where: { id: commandId },
      data: {
        status: data.status as any,
        response: data.response ?? undefined,
        error: errMsg,
      },
    })
    .catch(() => undefined);
}

async function createQnaAnswerCommand(connectionId: string, cfg: TrendyolConfig, params?: any) {
  const qnaCommandId = params?.qnaCommandId ? String(params.qnaCommandId) : null;
  const questionId = String(params?.questionId ?? params?.id ?? "").trim();
  const text = String(params?.text ?? "").trim();
  const dryRunParam = !!params?.dryRun;
  const executorApp = params?.executorApp != null ? String(params.executorApp) : null;
  const executorUser = params?.executorUser != null ? String(params.executorUser) : null;

  if (!qnaCommandId) throw new Error("qnaCommandId required");
  if (!questionId) throw new Error("questionId required");
  if (!text) throw new Error("text required");
  if (text.length < 10 || text.length > 2000) throw new Error("text length must be 10-2000");

  // Idempotency guard: if command already succeeded, do nothing.
  const cmdRow = await prisma.qnaCommand.findUnique({
    where: { id: qnaCommandId },
    select: { status: true, response: true },
  });
  if (cmdRow?.status === "succeeded") {
    return {
      ok: true,
      mode: "idempotent",
      note: "qnaCommand already succeeded",
      qnaCommandId,
      questionId,
      response: cmdRow.response ?? null,
    };
  }

  // Mark running (best-effort)
  await prisma.qnaCommand
    .update({ where: { id: qnaCommandId }, data: { status: "running", error: null } })
    .catch(() => undefined);

  const writeEnabledEnv = String(process.env.TRENDYOL_WRITE_ENABLED ?? "").toLowerCase() === "true";
  const isDry = dryRunParam || !writeEnabledEnv;

  const toDateMaybe = (v: any): Date | null => {
    const n = typeof v === "string" && v.trim().length ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return new Date(n);
    if (v instanceof Date) return v;
    return null;
  };

  const upsertFromRemote = async (remote: any | null, extra?: { forceAnswerText?: string; forceAnsweredAt?: Date }) => {
    const item = remote ?? {};

    const askedAt = toDateMaybe(item?.creationDate ?? item?.askedAt ?? item?.askedAtMillis);
    const lastModifiedAt =
      toDateMaybe(item?.lastModifiedDate ?? item?.lastModifiedAt ?? item?.updatedDate ?? item?.modifiedDate);

    const qRow = await prisma.question.upsert({
      where: {
        connectionId_marketplace_questionId: { connectionId, marketplace: "trendyol", questionId },
      },
      create: {
        connectionId,
        marketplace: "trendyol",
        questionId,
        status: item?.status != null ? String(item.status).trim() || null : null,
        askedAt: askedAt ?? undefined,
        lastModifiedAt: lastModifiedAt ?? undefined,
        customerId: item?.customerId != null ? String(item.customerId) : item?.userId != null ? String(item.userId) : null,
        userName: item?.userName != null ? String(item.userName) : null,
        showUserName: typeof item?.showUserName === "boolean" ? item.showUserName : null,
        productName:
          item?.productName != null
            ? String(item.productName)
            : item?.product?.name != null
              ? String(item.product.name)
              : null,
        productMainId:
          item?.productMainId != null
            ? String(item.productMainId)
            : item?.product?.mainId != null
              ? String(item.product.mainId)
              : null,
        imageUrl:
          item?.productImageUrl != null
            ? String(item.productImageUrl)
            : item?.imageUrl != null
              ? String(item.imageUrl)
              : null,
        webUrl:
          item?.webUrl != null
            ? String(item.webUrl)
            : item?.productUrl != null
              ? String(item.productUrl)
              : null,
        text:
          item?.text != null
            ? String(item.text)
            : item?.questionText != null
              ? String(item.questionText)
              : null,
        raw: (remote ?? { _note: "remote_detail_missing" }) as any,
      },
      update: {
        status: item?.status != null ? String(item.status).trim() || null : undefined,
        askedAt: askedAt ?? undefined,
        lastModifiedAt: lastModifiedAt ?? undefined,
        customerId: item?.customerId != null ? String(item.customerId) : item?.userId != null ? String(item.userId) : null,
        userName: item?.userName != null ? String(item.userName) : null,
        showUserName: typeof item?.showUserName === "boolean" ? item.showUserName : null,
        productName:
          item?.productName != null
            ? String(item.productName)
            : item?.product?.name != null
              ? String(item.product.name)
              : null,
        productMainId:
          item?.productMainId != null
            ? String(item.productMainId)
            : item?.product?.mainId != null
              ? String(item.product.mainId)
              : null,
        imageUrl:
          item?.productImageUrl != null
            ? String(item.productImageUrl)
            : item?.imageUrl != null
              ? String(item.imageUrl)
              : null,
        webUrl:
          item?.webUrl != null
            ? String(item.webUrl)
            : item?.productUrl != null
              ? String(item.productUrl)
              : null,
        text:
          item?.text != null
            ? String(item.text)
            : item?.questionText != null
              ? String(item.questionText)
              : null,
        raw: (remote ?? { _note: "remote_detail_missing" }) as any,
      },
      select: { id: true },
    });

    const ans = item?.answer ?? null;
    const answerTextRemote = ans?.text != null ? String(ans.text).trim() : ans?.answerText != null ? String(ans.answerText).trim() : "";
    const answerText = (answerTextRemote || extra?.forceAnswerText || "").trim();

    if (answerText.length) {
      const answeredAtRemote = toDateMaybe(ans?.creationDate ?? ans?.answeredAt ?? ans?.answeredAtMillis);
      const answeredAt = answeredAtRemote ?? extra?.forceAnsweredAt ?? new Date();

      await prisma.answer.upsert({
        where: {
          connectionId_marketplace_questionId: { connectionId, marketplace: "trendyol", questionId },
        },
        create: {
          connectionId,
          marketplace: "trendyol",
          questionDbId: qRow.id,
          questionId,
          answerText,
          answeredAt: answeredAt ?? undefined,
          executorApp: executorApp,
          executorUser: executorUser,
          raw: (ans ?? { _note: "answer_missing_in_detail" }) as any,
        },
        update: {
          answerText,
          answeredAt: answeredAt ?? undefined,
          executorApp: executorApp,
          executorUser: executorUser,
          raw: (ans ?? { _note: "answer_missing_in_detail" }) as any,
        },
      });
    }

    return { questionDbId: qRow.id, hasAnswer: !!answerText.length, answerText };
  };

  try {
    // Preflight: if already answered remotely, just sync + succeed.
    let detail: any = null;
    try {
      detail = await trendyolQnaQuestionById(cfg, questionId);
    } catch {
      detail = null;
    }

    const preAns = detail?.answer ?? null;
    const preText = preAns?.text != null ? String(preAns.text).trim() : preAns?.answerText != null ? String(preAns.answerText).trim() : "";

    if (preText.length) {
      const syncRes = await upsertFromRemote(detail);
      const out = {
        ok: true,
        mode: "already_answered",
        questionId,
        remoteAnswerText: preText,
        synced: syncRes,
      };
      await finishQnaCommand(qnaCommandId, { status: "succeeded", response: out });
      return out;
    }

    if (isDry) {
      const note = dryRunParam ? "dryRun=1 → remote call skipped" : "TRENDYOL_WRITE_ENABLED=false → remote call skipped";
      const out = { ok: true, mode: "dry", dryRun: true, note, questionId };
      await finishQnaCommand(qnaCommandId, { status: "succeeded", response: out });
      return out;
    }

    // Real write
    const resp = await trendyolQnaCreateAnswer(cfg, questionId, text);

    // Fetch detail as proof + update DB
    let detail2: any = null;
    try {
      detail2 = await trendyolQnaQuestionById(cfg, questionId);
    } catch {
      detail2 = null;
    }

    const synced = await upsertFromRemote(detail2, { forceAnswerText: text, forceAnsweredAt: new Date() });

    const out = {
      ok: true,
      mode: "sent",
      questionId,
      response: resp,
      detailFetched: !!detail2,
      synced,
    };

    await finishQnaCommand(qnaCommandId, { status: "succeeded", response: out });
    return out;
  } catch (e: any) {
    await finishQnaCommand(qnaCommandId, { status: "failed", error: e });
    throw e;
  }
}

async function enforceClaimsWriteRateLimit(connectionId: string) {
  // Trendyol limits: approve/reject/createClaim = 5 req / minute
  const key = `eci:ratelimit:trendyol:claims_write:${connectionId}`;
  const n = await redis.incr(key);
  if (n === 1) {
    await redis.pexpire(key, 60_000);
  }
  if (n > 5) {
    throw new Error(`rate_limit_exceeded claims_write n=${n} limit=5`);
  }
}

async function finishClaimCommand(commandId: string | null | undefined, data: { status: string; response?: any; error?: any }) {
  if (!commandId) return;
  await prisma.claimCommand.update({
    where: { id: commandId },
    data: {
      status: data.status as any,
      response: data.response ?? undefined,
      error: data.error ? { message: String(data.error?.message ?? data.error), raw: data.error } : undefined,
      finishedAt: new Date(),
    },
  }).catch(() => undefined);
}

async function approveClaimItems(connectionId: string, cfg: TrendyolConfig, params?: any) {
  const claimId = String(params?.claimId ?? "");
  const claimLineItemIdList: string[] | null =
    Array.isArray(params?.claimLineItemIdList) ? params.claimLineItemIdList.map(String) : null;
  const claimCommandId = params?.claimCommandId ? String(params.claimCommandId) : null;
  const dryRun = !!params?.dryRun;

  if (!claimId) throw new Error("claimId required");

  try {
    await enforceClaimsWriteRateLimit(connectionId);

    const writeEnabledEnv = String(process.env.TRENDYOL_WRITE_ENABLED ?? "").toLowerCase() === "true";
    if (dryRun || !writeEnabledEnv) {
      const note = dryRun
        ? "dryRun=1 → remote call skipped"
        : "TRENDYOL_WRITE_ENABLED=false → remote call skipped";
      const resp = { ok: true, dryRun: true, note, claimId, claimLineItemIdList };
      await finishClaimCommand(claimCommandId, { status: "succeeded", response: resp });
      return resp;
    }

    const resp = await trendyolApproveClaimLineItems(cfg, {
      claimId,
      claimLineItemIdList: claimLineItemIdList ?? [],
    });

    // Collect audits as "proof" and sync item statuses based on latest audit entry.
    const auditsByItem: Record<string, any[]> = {};
    const itemsToAudit = claimLineItemIdList ?? [];
    for (const claimItemId of itemsToAudit) {
      try {
        const audits = await trendyolGetClaimAudits(cfg, claimItemId);
        auditsByItem[claimItemId] = audits ?? [];
      } catch (e) {
        auditsByItem[claimItemId] = [{ error: String((e as any)?.message ?? e) }];
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const claimItemId of Object.keys(auditsByItem)) {
        const dbItem = await tx.claimItem.findFirst({
          where: { connectionId, marketplace: "trendyol", claimItemId },
          select: { id: true, itemStatus: true },
        });
        if (!dbItem) continue;

        const audits = auditsByItem[claimItemId] ?? [];
        // Write audits (best effort; avoid duplicates via unique constraint)
        for (const a of audits) {
          if (!a || a.error) continue;
          const date = new Date(a.date);
          const newStatus = String(a.newStatus ?? "");
          if (!newStatus) continue;

          await tx.claimAudit
            .create({
              data: {
                connectionId,
                marketplace: "trendyol",
                claimItemDbId: dbItem.id,
                previousStatus: String(a.previousStatus ?? null),
                newStatus,
                executorApp: String(a.executorApp ?? null),
                executorUser: String(a.executorUser ?? null),
                date,
                raw: a,
              },
            })
            .catch(() => undefined);
        }

        // Update itemStatus to the latest audit status if present
        const last = audits
          .filter((x) => x && !x.error && x.date)
          .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
          .slice(-1)[0];

        if (last?.newStatus) {
          await tx.claimItem.update({ where: { id: dbItem.id }, data: { itemStatus: String(last.newStatus) } });
        }
      }
    });

    const out = { ok: true, claimId, response: resp, auditsCollected: Object.keys(auditsByItem).length };
    await finishClaimCommand(claimCommandId, { status: "succeeded", response: out });
    return out;
  } catch (e: any) {
    await finishClaimCommand(claimCommandId, { status: "failed", error: e });
    throw e;
  }
}

async function rejectClaimIssue(connectionId: string, cfg: TrendyolConfig, params?: any) {
  const claimId = String(params?.claimId ?? "");
  const claimLineItemIdList: string[] = Array.isArray(params?.claimLineItemIdList)
    ? params.claimLineItemIdList.map(String)
    : [];
  const claimIssueReasonId = Number(params?.claimIssueReasonId);
  const description = String(params?.description ?? "");
  const fileName = params?.fileName ? String(params.fileName) : null;
  const fileBase64 = params?.fileBase64 ? String(params.fileBase64) : null;
  const claimCommandId = params?.claimCommandId ? String(params.claimCommandId) : null;
  const dryRun = !!params?.dryRun;

  if (!claimId) throw new Error("claimId required");
  if (!claimLineItemIdList.length) throw new Error("claimLineItemIdList required");
  if (!claimIssueReasonId || Number.isNaN(claimIssueReasonId)) throw new Error("claimIssueReasonId required");
  if (!description) throw new Error("description required");

  try {
    await enforceClaimsWriteRateLimit(connectionId);

    const writeEnabledEnv = String(process.env.TRENDYOL_WRITE_ENABLED ?? "").toLowerCase() === "true";
    if (dryRun || !writeEnabledEnv) {
      const note = dryRun
        ? "dryRun=1 → remote call skipped"
        : "TRENDYOL_WRITE_ENABLED=false → remote call skipped";
      const resp = { ok: true, dryRun: true, note, claimId, claimLineItemIdList, claimIssueReasonId };
      await finishClaimCommand(claimCommandId, { status: "succeeded", response: resp });
      return resp;
    }

    const fileNotRequired = [1651, 451, 2101].includes(claimIssueReasonId);
    if (!fileNotRequired && !fileBase64) {
      throw new Error(`file required for claimIssueReasonId=${claimIssueReasonId}`);
    }

    const file =
      fileBase64 && fileName
        ? {
            filename: fileName,
            contentType: fileName.toLowerCase().endsWith(".pdf")
              ? "application/pdf"
              : fileName.toLowerCase().match(/\.(png|jpg|jpeg|webp)$/)
                ? `image/${fileName.toLowerCase().split(".").pop()}`
                : "application/octet-stream",
            buffer: Buffer.from(fileBase64, "base64"),
          }
        : null;

    const resp = await trendyolCreateClaimIssue(cfg, {
      claimId,
      claimItemIdList: claimLineItemIdList,
      claimIssueReasonId,
      description,
      file: file ? { filename: file.filename, contentType: file.contentType, buffer: file.buffer } : undefined,
    });

    const out = { ok: true, claimId, response: resp };
    await finishClaimCommand(claimCommandId, { status: "succeeded", response: out });
    return out;
  } catch (e: any) {
    await finishClaimCommand(claimCommandId, { status: "failed", error: e });
    throw e;
  }
}

async function createClaimCommand(connectionId: string, cfg: TrendyolConfig, params?: any) {
  const claimCommandId = params?.claimCommandId ? String(params.claimCommandId) : null;
  const dryRun = !!params?.dryRun;
  const body = params?.body ?? null;
  if (!body) throw new Error("body required");

  try {
    await enforceClaimsWriteRateLimit(connectionId);

    const writeEnabledEnv = String(process.env.TRENDYOL_WRITE_ENABLED ?? "").toLowerCase() === "true";
    if (dryRun || !writeEnabledEnv) {
      const note = dryRun
        ? "dryRun=1 → remote call skipped"
        : "TRENDYOL_WRITE_ENABLED=false → remote call skipped";
      const resp = { ok: true, dryRun: true, note };
      await finishClaimCommand(claimCommandId, { status: "succeeded", response: resp });
      return resp;
    }

    const resp = await trendyolCreateClaim(cfg, body);
    const out = { ok: true, response: resp };
    await finishClaimCommand(claimCommandId, { status: "succeeded", response: out });
    return out;
  } catch (e: any) {
    await finishClaimCommand(claimCommandId, { status: "failed", error: e });
    throw e;
  }
}



const SYNC_JOB_NAMES = new Set([
  "TRENDYOL_SYNC_ORDERS",
  "TRENDYOL_SYNC_SHIPMENT_PACKAGES", // backward-compat
  "TRENDYOL_SYNC_ORDERS_TARGETED",
  "TRENDYOL_SYNC_CLAIMS",
  "TRENDYOL_SYNC_QNA_QUESTIONS",
  "TRENDYOL_CLAIM_APPROVE",
  "TRENDYOL_CLAIM_REJECT_ISSUE",
  "TRENDYOL_CLAIM_CREATE",
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


async function extractProductItems(data: any): Promise<{ items: any[]; totalPages: number | null }> {
  const items: any[] =
    Array.isArray(data)
      ? data
      : Array.isArray(data?.content)
        ? data.content
        : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data?.products)
            ? data.products
            : [];

  const totalPages =
    typeof data?.totalPages === "number"
      ? data.totalPages
      : typeof data?.pageCount === "number"
        ? data.pageCount
        : typeof data?.totalPageCount === "number"
          ? data.totalPageCount
          : null;

  return { items, totalPages };
}

function safeNumber(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function syncProducts(connectionId: string, cfg: TrendyolConfig, params: any) {
  const includeApproved = params?.includeApproved ?? true;
  const includeUnapproved = params?.includeUnapproved ?? true;

  const pageSize = Math.min(200, Math.max(1, Number(params?.pageSize ?? 50) || 50));
  const maxPages = params?.maxPages != null ? Math.max(1, Number(params.maxPages) || 1) : null;

  const marketplace = "trendyol";

  let pagesFetched = 0;
  let fetched = 0;
  let upsertedProducts = 0;
  let upsertedVariants = 0;

  async function processList(kind: "approved" | "unapproved") {
    let page = 0;
    let totalPages: number | null = null;

    while (totalPages === null || page < totalPages) {
      if (maxPages != null && page >= maxPages) break;

      const q: ProductsListQuery = { page, size: pageSize };
      const data =
        kind === "approved"
          ? await trendyolListApprovedProducts(cfg, q)
          : await trendyolListUnapprovedProducts(cfg, q);

      const { items, totalPages: tp } = await extractProductItems(data);
      if (totalPages === null && tp != null) totalPages = tp;

      pagesFetched++;
      if (!items.length) break;

      for (const it of items) {
        fetched++;

        const barcode = String(it?.barcode ?? "").trim();
        const productCode = String(it?.productCode ?? it?.stockCode ?? it?.productMainId ?? barcode ?? "").trim();
        if (!productCode) continue;

        const title = String(it?.title ?? it?.productName ?? "").trim() || null;

        const brandId = safeNumber(it?.brandId);
        const categoryId = safeNumber(it?.categoryId);

        const rawStatus =
          String(
            it?.approvalStatus ??
              it?.status ??
              it?.productStatusType ??
              (kind === "approved" ? "APPROVED" : "UNAPPROVED")
          ).trim() || (kind === "approved" ? "APPROVED" : "UNAPPROVED");

        const approved = kind === "approved";
        const archived = Boolean(it?.archived) || /archived/i.test(rawStatus);

        const product = await prisma.product.upsert({
          where: {
            connectionId_marketplace_productCode: {
              connectionId,
              marketplace,
              productCode,
            },
          },
          create: {
            connectionId,
            marketplace,
            productCode,
            title,
brandId,
            categoryId,
            status: rawStatus,
            approved,
            archived,
            raw: it,
          },
          update: {
            title,
brandId,
            categoryId,
            status: rawStatus,
            approved,
            archived,
            raw: it,
          },
          select: { id: true },
        });

        upsertedProducts++;

        // Variant/sku row (keyed by barcode)
        if (barcode) {
          const stock = safeNumber(it?.quantity ?? it?.stock ?? it?.stockQuantity);
          const listPrice = safeNumber(it?.listPrice);
          const salePrice = safeNumber(it?.salePrice);
          const currency = it?.currencyType != null ? String(it.currencyType) : null;

          await prisma.productVariant.upsert({
            where: {
              connectionId_marketplace_barcode: {
                connectionId,
                marketplace,
                barcode,
              },
            },
            create: {
              connectionId,
              marketplace,
              barcode,
              productId: product.id,
              stock: stock != null ? Math.trunc(stock) : null,
              listPrice,
              salePrice,
              currency,
              raw: it,
            },
            update: {
              productId: product.id,
              stock: stock != null ? Math.trunc(stock) : null,
              listPrice,
              salePrice,
              currency,
              raw: it,
            },
          });

          upsertedVariants++;
        }
      }

      // If Trendyol doesn't provide totalPages, stop when we receive a short page.
      if (totalPages === null && items.length < pageSize) break;

      page++;
    }
  }

  log("syncProducts started", {
    connectionId,
    includeApproved,
    includeUnapproved,
    pageSize,
    maxPages,
  });

  if (includeApproved) await processList("approved");
  if (includeUnapproved) await processList("unapproved");

  log("syncProducts finished", {
    connectionId,
    fetched,
    upsertedProducts,
    upsertedVariants,
    pagesFetched,
  });

  return { fetched, upsertedProducts, upsertedVariants, pagesFetched, pageSize };
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


// -----------------------------------------------------------------------------
// Worker identity + dispatch guard (Sprint 9 hardening)
// -----------------------------------------------------------------------------

const KNOWN_JOBS = [
  "TRENDYOL_SYNC_ORDERS",
  "TRENDYOL_SYNC_SHIPMENT_PACKAGES",
  "TRENDYOL_SYNC_ORDERS_TARGETED",
  "TRENDYOL_SYNC_CLAIMS",
  "TRENDYOL_CLAIM_APPROVE",
  "TRENDYOL_CLAIM_REJECT_ISSUE",
  "TRENDYOL_CLAIM_CREATE",
  "TRENDYOL_WEBHOOK_EVENT",
  "TRENDYOL_SYNC_PRODUCTS",
  "TRENDYOL_PUSH_PRODUCTS",
  "TRENDYOL_PUSH_PRICE_STOCK",
  "TRENDYOL_SYNC_QNA_QUESTIONS",
  "TRENDYOL_QNA_CREATE_ANSWER",
] as const;

function redactUrl(u: string) {
  try {
    const url = new URL(u);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return String(u ?? "").replace(/\/\/[^@]+@/g, "//***:***@");
  }
}

function fileHash12(p: string) {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

(() => {
  const entry = String(process.argv?.[1] ?? "");
  log("WORKER_BOOT", {
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    entry,
    entryHash12: entry ? fileHash12(entry) : null,
    queue: "eci-jobs",
    redisUrl: redactUrl(process.env.REDIS_URL ?? "redis://localhost:6379"),
    knownJobs: KNOWN_JOBS,
  });
})();

const worker = new Worker(
  "eci-jobs",
  async (job: Job<JobData, any, string>) => {
    // NOTE (Sprint 9): PUSH_PRODUCTS jobs carry `push` + `payload` fields.
    // If we don't destructure them here, the handler will throw at runtime
    // ("push is not defined" / "payload is not defined").
    const { connectionId, jobId, params, webhook, target, push, payload } = job.data as JobData;

    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    log("job received", {
      name: job.name,
      jobId,
      connectionId,
      attempt,
      maxAttempts,
    });

    const effectiveJobName = (job.name === "job" && (job as any).data?.type) ? (job as any).data.type : job.name;

    const isSync = isSyncJob(effectiveJobName);

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

      switch (effectiveJobName) {
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

        
case "TRENDYOL_SYNC_QNA_QUESTIONS": {
  // Sprint 13 Step 4.1: Wire QnA sync job (dry-run fetch)
  summary = await syncQnaQuestions(connectionId, cfg, params ?? undefined);
  summary = {
    ...summary,
    durationMs: Date.now() - t0,
  };
  break;
}

case "TRENDYOL_QNA_CREATE_ANSWER": {
  // Sprint 13 Step 4.3+: Answer (Write path)
  summary = await createQnaAnswerCommand(connectionId, cfg, params ?? undefined);
  summary = {
    ...summary,
    durationMs: Date.now() - t0,
  };
  break;
}

case "TRENDYOL_SYNC_CLAIMS": {
          summary = await syncClaims(connectionId, cfg, params ?? undefined);
          summary = {
            ...summary,
            durationMs: Date.now() - t0,
          };
          break;
        }


case "TRENDYOL_CLAIM_APPROVE": {
  summary = await approveClaimItems(connectionId, cfg, params ?? undefined);
  break;
}

case "TRENDYOL_CLAIM_REJECT_ISSUE": {
  summary = await rejectClaimIssue(connectionId, cfg, params ?? undefined);
  break;
}

case "TRENDYOL_CLAIM_CREATE": {
  summary = await createClaimCommand(connectionId, cfg, params ?? undefined);
  break;
}

        case "TRENDYOL_SYNC_PRODUCTS": {
          // Sprint 9: Product sync (Trendyol -> DB)
          summary = await syncProducts(connectionId, cfg, params);
          break;
        }

        case "TRENDYOL_PUSH_PRODUCTS": {
          // Sprint 9: Product create/update (DB/API -> Trendyol)
          const actionRaw = String((push as any)?.action ?? "create").toLowerCase();
          const action: "create" | "update" = actionRaw === "update" ? "update" : "create";
          if (!payload) throw new Error("payload required");

          const resp = action === "update"
            ? await trendyolUpdateProducts(cfg, payload)
            : await trendyolCreateProducts(cfg, payload);

          const batch = (resp as any)?.batchRequestId ?? (resp as any)?.batchrequestId ?? (resp as any)?.id ?? null;
          const remoteBatchId = batch != null ? String(batch) : null;

          const pbr = await prisma.productBatchRequest.create({
            data: {
              connectionId,
              marketplace: "trendyol",
              remoteBatchId,
              type: action === "update" ? "UPDATE_PRODUCTS" : "CREATE_PRODUCTS",
              status: "created",
              raw: { request: payload, response: resp },
            },
            select: { id: true, remoteBatchId: true },
          });

          summary = {
            action,
            productBatchRequestId: pbr.id,
            batchRequestId: pbr.remoteBatchId,
            durationMs: Date.now() - t0,
          };

          break;
        }



        case "TRENDYOL_PUSH_PRICE_STOCK": {
          // Sprint 10: Price + stock update (DB/API -> Trendyol)
          if (!payload) throw new Error("payload required");

          const writeEnabledEnv = String(process.env.TRENDYOL_WRITE_ENABLED ?? "").toLowerCase() === "true";

          // Payload is expected to be the raw Trendyol body: { items: [...] }
          const meta = (payload as any)?.__eci ?? null;
          const reqBody = { ...(payload as any) };
          if ((reqBody as any).__eci) delete (reqBody as any).__eci;

          const items = Array.isArray((reqBody as any)?.items) ? (reqBody as any).items : [];
          if (items.length === 0) throw new Error("items required");
          if (items.length > 1000) throw new Error("max 1000 items");

          const dryRun = !!meta?.dryRun;
          const forceWriteParam = !!meta?.forceWrite;

          const forceWriteAllowed =
            String(process.env.ECI_ALLOW_FORCE_WRITE ?? "").toLowerCase() === "true" ||
            String(process.env.NODE_ENV ?? "").toLowerCase() !== "production";

          const forceWriteEffective = forceWriteParam && forceWriteAllowed && !dryRun;
          const writeEnabled = (writeEnabledEnv || forceWriteEffective) && !dryRun;

          if (!writeEnabled) {
            summary = {
              dryRun,
              writeEnabled,
              writeEnabledEnv,
              forceWriteParam,
              forceWriteAllowed,
              forceWriteEffective,
              note: dryRun ? "dryRun=1 → remote call skipped" : "TRENDYOL_WRITE_ENABLED=false → remote call skipped",
              bodyHash: meta?.bodyHash ?? null,
              originalCount: meta?.originalCount ?? null,
              coalescedCount: meta?.coalescedCount ?? null,
              itemCount: items.length,
              durationMs: Date.now() - t0,
            };
            break;
          }

          const resp = await trendyolUpdatePriceAndInventory(cfg, reqBody);
          const batch = (resp as any)?.batchRequestId ?? (resp as any)?.batchrequestId ?? (resp as any)?.id ?? null;
          const batchRequestId = batch != null ? String(batch) : null;

          summary = {
            dryRun: false,
            writeEnabled,
            writeEnabledEnv,
            forceWriteParam,
            forceWriteAllowed,
            forceWriteEffective,
            bodyHash: meta?.bodyHash ?? null,
            originalCount: meta?.originalCount ?? null,
            coalescedCount: meta?.coalescedCount ?? null,
            itemCount: items.length,
            batchRequestId,
            response: resp,
            durationMs: Date.now() - t0,
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
          throw new Error(`unknown job: ${effectiveJobName}`);
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
      const retrying = shouldRetryForJob(effectiveJobName, err) && attempt < maxAttempts;

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