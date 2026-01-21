/*
Sprint 10 — Inventory (Price & Stock)
====================================

Goals (Sprint 10):
- API: enqueue inventory push job (idempotent-ish / dedup window)
- API: batch result proxy (uses product batch result endpoint per Trendyol PDF)
- Worker: call Trendyol updatePriceAndInventory when writes are enabled

Hard constraints (Trendyol PDF):
- Same request body cannot be resent for 15 minutes.
- Max 1000 items per request.
- Stock max 20.000 per SKU.
- updatePriceAndInventory returns batchRequestId; results must be polled.

ECI additions (Sprint 10):
- Changed-only diff (uses DB: inventory_confirmed_state)
- Chunking: N items => ceil(N/1000) jobs
- dryRun=1 option: prove chunking without hitting Trendyol
*/

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import IORedis from "ioredis";
import { createHash } from "crypto";

import { prisma } from "./prisma";
import { decryptJson } from "./lib/crypto";
import { eciQueue } from "./queue";

import type { TrendyolConfig } from "./connectors/trendyol/client";
import { trendyolGetProductBatchRequestResult } from "./connectors/trendyol/client";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

const DEDUP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes (Trendyol PDF rule)
const MAX_ITEMS_PER_TRENDYOL_REQUEST = 1000;
const MAX_ITEMS_PER_ECI_REQUEST = 5000; // Sprint 10: allow 1001+ for chunking proof

// Express 4 does NOT automatically catch async errors.
const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any> | any) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function parseBool(v: unknown): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function normalizeConfig(cfg: TrendyolConfig): TrendyolConfig {
  const sellerId = String(cfg.sellerId ?? "").trim();
  const tokenRaw = cfg.token != null ? String(cfg.token).trim() : undefined;
  const apiKey = cfg.apiKey != null ? String(cfg.apiKey).trim() : undefined;
  const apiSecret = cfg.apiSecret != null ? String(cfg.apiSecret).trim() : undefined;
  const baseUrlRaw = cfg.baseUrl != null ? String(cfg.baseUrl).trim() : undefined;

  return {
    ...cfg,
    sellerId,
    token: tokenRaw ? tokenRaw.replace(/^Basic\s+/i, "").trim() : undefined,
    apiKey,
    apiSecret,
    agentName: String(cfg.agentName ?? "Easyso").trim(),
    integrationName: String(cfg.integrationName ?? "ECI").trim(),
    baseUrl: baseUrlRaw ? baseUrlRaw.replace(/\/+$/, "") : undefined,
  };
}

const TrendyolConfigSchema: z.ZodType<TrendyolConfig> = z
  .object({
    sellerId: z.string().min(1),
    env: z.enum(["prod", "stage"]).optional(),
    baseUrl: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    token: z.string().optional(),
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),
    preferSapigw: z.boolean().optional(),
    agentName: z.string().optional(),
    integrationName: z.string().optional(),
    probeLegacy: z.boolean().optional(),
  })
  .refine((v) => !!(v.token || (v.apiKey && v.apiSecret)), {
    message: "Trendyol config must include token or apiKey+apiSecret",
  });

const InventoryItemSchema = z
  .object({
    barcode: z.string().min(1),
    quantity: z.number().int().min(0).max(20000),
    salePrice: z.number().nonnegative(),
    listPrice: z.number().nonnegative(),
    currencyType: z.string().optional(),
  })
  .strict();

const InventoryPushSchema = z
  .object({
    connectionId: z.string().min(1),
    items: z.array(InventoryItemSchema).min(1).max(MAX_ITEMS_PER_ECI_REQUEST),
  })
  .strict();

type InventoryItem = z.infer<typeof InventoryItemSchema>;

function canonicalizeItems(items: InventoryItem[]) {
  // Coalesce duplicates inside a single request (last write wins per barcode).
  const map = new Map<string, InventoryItem>();
  for (const it of items) {
    const bc = String(it.barcode ?? "").trim();
    if (!bc) continue;
    map.set(bc, {
      barcode: bc,
      quantity: Number(it.quantity),
      salePrice: Number(it.salePrice),
      listPrice: Number(it.listPrice),
      currencyType: it.currencyType ? String(it.currencyType).trim() : undefined,
    });
  }

  const normalized = Array.from(map.values())
    .sort((a, b) => a.barcode.localeCompare(b.barcode))
    .map((x) => ({
      barcode: x.barcode,
      quantity: x.quantity,
      salePrice: x.salePrice,
      listPrice: x.listPrice,
      ...(x.currencyType ? { currencyType: x.currencyType } : {}),
    }));

  return {
    originalCount: items.length,
    coalescedCount: normalized.length,
    items: normalized,
  };
}

function moneyKey(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "NaN";
  return v.toFixed(4);
}

function sameAsConfirmed(
  confirmed: { quantity: number; salePrice: any; listPrice: any; currencyType: string | null },
  it: InventoryItem
): boolean {
  const qtyEq = Number(confirmed.quantity) === Number(it.quantity);
  const saleEq = String(confirmed.salePrice) === moneyKey(it.salePrice);
  const listEq = String(confirmed.listPrice) === moneyKey(it.listPrice);
  const curA = confirmed.currencyType ? String(confirmed.currencyType) : "";
  const curB = it.currencyType ? String(it.currencyType) : "";
  return qtyEq && saleEq && listEq && curA === curB;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}


// --- Sprint 10 persistence helpers ---
// We prefer Prisma model InventoryConfirmedState when available.
// But to avoid "you must regenerate prisma client" footguns in local dev,
// we provide a raw SQL fallback that works as long as the table exists.

async function loadConfirmedRows(connectionId: string, barcodes: string[]) {
  const invConfirmed = (prisma as any).inventoryConfirmedState;
  if (invConfirmed) {
    const rows = await invConfirmed.findMany({
      where: { connectionId, barcode: { in: barcodes } },
      select: { barcode: true, quantity: true, salePrice: true, listPrice: true, currencyType: true },
    });
    return rows as any[];
  }

  if (barcodes.length === 0) return [];
  const params: any[] = [connectionId, ...barcodes];
  const placeholders = barcodes.map((_, i) => `$${i + 2}`).join(",");
  const sql = `select "barcode","quantity","salePrice","listPrice","currencyType" from "inventory_confirmed_state" where "connectionId"=$1 and "barcode" in (${placeholders});`;
  return (await prisma.$queryRawUnsafe<any[]>(sql, ...params)) ?? [];
}

async function upsertConfirmedRow(args: {
  connectionId: string;
  barcode: string;
  quantity: number;
  salePrice: string;
  listPrice: string;
  currencyType: string | null;
  batchRequestId: string;
  confirmedAt: Date;
}) {
  const invConfirmed = (prisma as any).inventoryConfirmedState;
  if (invConfirmed) {
    await invConfirmed.upsert({
      where: { connectionId_barcode: { connectionId: args.connectionId, barcode: args.barcode } },
      create: {
        connectionId: args.connectionId,
        barcode: args.barcode,
        quantity: args.quantity,
        salePrice: args.salePrice,
        listPrice: args.listPrice,
        currencyType: args.currencyType,
        lastBatchRequestId: args.batchRequestId,
        lastConfirmedAt: args.confirmedAt,
      },
      update: {
        quantity: args.quantity,
        salePrice: args.salePrice,
        listPrice: args.listPrice,
        currencyType: args.currencyType,
        lastBatchRequestId: args.batchRequestId,
        lastConfirmedAt: args.confirmedAt,
      },
    });
    return;
  }

  const sql = `
    insert into "inventory_confirmed_state"
      ("connectionId","barcode","quantity","salePrice","listPrice","currencyType","lastBatchRequestId","lastConfirmedAt","createdAt","updatedAt")
    values
      ($1,$2,$3,($4)::numeric,($5)::numeric,$6,$7,$8,now(),now())
    on conflict ("connectionId","barcode") do update set
      "quantity"=excluded."quantity",
      "salePrice"=excluded."salePrice",
      "listPrice"=excluded."listPrice",
      "currencyType"=excluded."currencyType",
      "lastBatchRequestId"=excluded."lastBatchRequestId",
      "lastConfirmedAt"=excluded."lastConfirmedAt",
      "updatedAt"=now();
  `.trim();

  await prisma.$executeRawUnsafe(
    sql,
    args.connectionId,
    args.barcode,
    args.quantity,
    args.salePrice,
    args.listPrice,
    args.currencyType,
    args.batchRequestId,
    args.confirmedAt
  );
}

export function registerSprint10InventoryRoutes(app: Express) {
  /**
   * POST /v1/inventory/push[?dryRun=1]
   * - Enqueues TRENDYOL_PUSH_PRICE_STOCK
   * - Dedups identical bodies for 15 minutes (prevents Trendyol same-body error)
   * - Changed-only diff: skips items already confirmed
   * - Chunking: splits >1000 items into multiple jobs
   */
  app.post(
    "/v1/inventory/push",
    asyncHandler(async (req: Request, res: Response) => {
      const dryRun = parseBool((req.query as any)?.dryRun);
      const force = parseBool((req.query as any)?.force);
      const forceWriteRequested = parseBool((req.query as any)?.forceWrite);

      // Proof helper: allow forcing a single remote send from API without restarting worker.
      // This is automatically allowed in non-production unless explicitly disabled.
      const forceWriteAllowed =
        String(process.env.ECI_ALLOW_FORCE_WRITE ?? "").toLowerCase() === "true" ||
        String(process.env.NODE_ENV ?? "").toLowerCase() !== "production";
      const forceWrite = forceWriteRequested && forceWriteAllowed;

      const parsed = InventoryPushSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "bad_request",
          message: "invalid payload",
          issues: parsed.error.issues,
        });
      }

      const { connectionId } = parsed.data;
      const { originalCount, coalescedCount, items } = canonicalizeItems(parsed.data.items);

      if (items.length === 0) {
        return res.status(400).json({ error: "bad_request", message: "items required" });
      }
      if (items.length > MAX_ITEMS_PER_ECI_REQUEST) {
        return res.status(400).json({
          error: "bad_request",
          message: `max ${MAX_ITEMS_PER_ECI_REQUEST} items per request`,
        });
      }

      const conn = await prisma.connection.findUnique({ where: { id: connectionId }, select: { id: true } });
      if (!conn) return res.status(404).json({ error: "not_found", message: "connection not found" });

      // Diff guard: if item matches confirmed DB state, skip it.
      // For proof / diagnostics we support ?force=1 to bypass diff and always enqueue.
      let changed: InventoryItem[] = [];
      let unchanged: InventoryItem[] = [];

      if (force) {
        changed = items;
        unchanged = [];
      } else {
        const barcodes = items.map((x) => x.barcode);
        const confirmedRows = await loadConfirmedRows(connectionId, barcodes);
        const confMap = new Map((confirmedRows as any[]).map((r) => [String((r as any).barcode), r]));

        for (const it of items) {
          const c = confMap.get(it.barcode);
          if (c && sameAsConfirmed(c as any, it)) unchanged.push(it);
          else changed.push(it);
        }
      }

      if (changed.length === 0) {
        // Note: bodyHash is chunk-specific; we return null here since no remote would be called anyway.
        return res.json({
          ok: true,
          noop: true,
          reason: "diff_no_change",
          dryRun,
          force,
          forceWrite,
          forceWriteAllowed,
          originalCount,
          coalescedCount,
          changedCount: 0,
          skippedCount: unchanged.length,
          dedupWindowMs: DEDUP_WINDOW_MS,
          chunkSize: MAX_ITEMS_PER_TRENDYOL_REQUEST,
        });
      }

      const chunks = chunk(changed, MAX_ITEMS_PER_TRENDYOL_REQUEST);
      const chunkCount = chunks.length;

      type JobChunkResult = {
        chunkIndex: number;
        itemCount: number;
        bodyHash: string;
        dedup: boolean;
        jobId: string;
      };

      const jobs: JobChunkResult[] = [];
      let enqueuedCount = 0;
      let dedupCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunkItems = chunks[i];

        const canonical = JSON.stringify({ items: chunkItems });
        const bodyHash = sha256Hex(canonical);
        const dedupKey = `eci:inv:dedup:${connectionId}:${bodyHash}`;

        const existing = await redis.get(dedupKey);
        if (existing) {
          dedupCount++;
          jobs.push({ chunkIndex: i, itemCount: chunkItems.length, bodyHash, dedup: true, jobId: existing });
          continue;
        }

        const jobRow = await prisma.job.create({
          data: {
            connectionId,
            type: "TRENDYOL_PUSH_PRICE_STOCK",
            status: "queued",
            startedAt: null,
            finishedAt: null,
            summary: null,
            error: null,
          },
          select: { id: true },
        });

        const payload = {
          items: chunkItems,
          __eci: {
            dryRun,
            forceWrite,
            bodyHash,
            originalCount,
            coalescedCount,
            changedCount: changed.length,
            skippedCount: unchanged.length,
            chunkIndex: i,
            chunkCount,
            chunkSize: MAX_ITEMS_PER_TRENDYOL_REQUEST,
            dedupWindowMs: DEDUP_WINDOW_MS,
            requestedAt: new Date().toISOString(),
          },
        };

        await eciQueue.add(
          "TRENDYOL_PUSH_PRICE_STOCK",
          { jobId: jobRow.id, connectionId, payload },
          {
            attempts: 6,
            backoff: { type: "exponential", delay: 5_000 },
            removeOnComplete: 1000,
            removeOnFail: 1000,
          }
        );

        await redis.set(dedupKey, jobRow.id, "PX", DEDUP_WINDOW_MS);

        enqueuedCount++;
        jobs.push({ chunkIndex: i, itemCount: chunkItems.length, bodyHash, dedup: false, jobId: jobRow.id });
      }

      const oneChunk = jobs.length === 1;
      const status = enqueuedCount > 0 ? 202 : 200;

      return res.status(status).json({
        ok: true,
        dryRun,
        force,
        forceWrite,
        forceWriteAllowed,
        originalCount,
        coalescedCount,
        changedCount: changed.length,
        skippedCount: unchanged.length,
        chunkSize: MAX_ITEMS_PER_TRENDYOL_REQUEST,
        chunkCount,
        enqueuedCount,
        dedupCount,
        dedupWindowMs: DEDUP_WINDOW_MS,
        ...(oneChunk
          ? {
              // Backwards-compatible-ish fields for the single-item smoke test / dedup proof.
              jobId: jobs[0]?.jobId ?? null,
              bodyHash: jobs[0]?.bodyHash ?? null,
              dedup: jobs[0]?.dedup ?? false,
            }
          : {}),
        jobs,
      });
    })
  );

  /**
   * GET /v1/inventory/batch/:batchRequestId?connectionId=...
   * - Trendyol PDF notes that inventory batch results are queried via the *product* batch result endpoint.
   * - On SUCCESS items, upserts inventory_confirmed_state (DB) to support changed-only diff.
   */
  app.get(
    "/v1/inventory/batch/:batchRequestId",
    asyncHandler(async (req: Request, res: Response) => {
      const batchRequestId = String(req.params.batchRequestId ?? "").trim();
      const connectionId = String(req.query.connectionId ?? "").trim();
      if (!batchRequestId) return res.status(400).json({ error: "bad_request", message: "batchRequestId required" });
      if (!connectionId) return res.status(400).json({ error: "bad_request", message: "connectionId required" });

      const conn = await prisma.connection.findUnique({
        where: { id: connectionId },
        select: { id: true, type: true, configEnc: true },
      });
      if (!conn) return res.status(404).json({ error: "not_found", message: "connection not found" });

      const raw = decryptJson(conn.configEnc);
      const cfg0 = TrendyolConfigSchema.parse(raw) as TrendyolConfig;
      const cfg = normalizeConfig(cfg0);

      const result: any = await trendyolGetProductBatchRequestResult(cfg, batchRequestId);
      const items = Array.isArray(result?.items) ? result.items : [];

      let confirmedUpserted = 0;
      const invConfirmed = (prisma as any).inventoryConfirmedState;
      for (const it of items) {
        const status = String((it as any)?.status ?? "").toUpperCase();
        if (status !== "SUCCESS") continue;

        const reqItem = (it as any)?.requestItem ?? (it as any)?.request ?? (it as any)?.request_item ?? null;

        const barcode = String((it as any)?.barcode ?? reqItem?.barcode ?? "").trim();
        if (!barcode) continue;

        const quantity = Number((it as any)?.quantity ?? reqItem?.quantity ?? NaN);
        const salePrice = Number(
          (it as any)?.salePrice ??
            (it as any)?.salesPrice ??
            reqItem?.salePrice ??
            reqItem?.salesPrice ??
            NaN
        );
        const listPrice = Number((it as any)?.listPrice ?? reqItem?.listPrice ?? NaN);
        const currencyType =
          (it as any)?.currencyType != null
            ? String((it as any)?.currencyType)
            : reqItem?.currencyType != null
              ? String(reqItem?.currencyType)
              : null;

        if (!Number.isFinite(quantity) || !Number.isFinite(salePrice) || !Number.isFinite(listPrice)) {
          continue;
        }

        // Prisma Decimal fields: safest is to pass string.
        const saleStr = moneyKey(salePrice);
        const listStr = moneyKey(listPrice);
        const now = new Date();

        await upsertConfirmedRow({
          connectionId,
          barcode,
          quantity: Math.max(0, Math.min(20000, Math.trunc(quantity))),
          salePrice: saleStr,
          listPrice: listStr,
          currencyType,
          batchRequestId: batchRequestId,
          confirmedAt: now,
        });

        confirmedUpserted++;
      }

      result._eci = {
        ...(result._eci ?? {}),
        confirmedUpserted,
        ...(invConfirmed ? {} : { note: "inventory_confirmed_state raw SQL fallback active (prisma client missing InventoryConfirmedState)" }),
      };
      return res.json(result);
    })
  );
}
