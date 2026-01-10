/*
Sprint 10 — Inventory (Price & Stock)
====================================

Goals (Sprint 10 / Phase 1):
- API: enqueue inventory push job (idempotent-ish / dedup window)
- API: batch result proxy (uses product batch result endpoint per Trendyol PDF)
- Worker: (optional) call Trendyol updatePriceAndInventory when writes are enabled

Notes:
- Trendyol endpoint (PDF): POST /integration/inventory/sellers/{sellerId}/products/price-and-inventory
- Dedup rule (PDF): same request body cannot be resent for 15 minutes.
- Limits (PDF): max 1000 items per request; stock max 20.000 per SKU.
*/

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import IORedis from "ioredis";
import { createHash } from "crypto";

import { prisma } from "./prisma";
import { decryptJson } from "./lib/crypto";
import { eciQueue } from "./queue";

import type { TrendyolConfig } from "./connectors/trendyol/client";
import {
  trendyolGetProductBatchRequestResult,
} from "./connectors/trendyol/client";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

const DEDUP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes (Trendyol PDF rule)

// Express 4 does NOT automatically catch async errors.
const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any> | any) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

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
    items: z.array(InventoryItemSchema).min(1).max(1000),
  })
  .strict();

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalizeItems(items: Array<z.infer<typeof InventoryItemSchema>>) {
  // Coalesce duplicates inside a single request (last write wins per barcode).
  const map = new Map<string, z.infer<typeof InventoryItemSchema>>();
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

export function registerSprint10InventoryRoutes(app: Express) {
  /**
   * POST /v1/inventory/push
   * - Enqueues TRENDYOL_PUSH_PRICE_STOCK
   * - Enforces max 1000 items and stock limit 20.000
   * - Dedups identical requests for 15 minutes (prevents Trendyol same-body error)
   */
  app.post(
    "/v1/inventory/push",
    asyncHandler(async (req: Request, res: Response) => {
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
      if (items.length > 1000) {
        return res.status(400).json({ error: "bad_request", message: "max 1000 items" });
      }

      const conn = await prisma.connection.findUnique({
        where: { id: connectionId },
        select: { id: true },
      });
      if (!conn) return res.status(404).json({ error: "not_found", message: "connection not found" });

      const canonical = JSON.stringify({ items });
      const bodyHash = sha256Hex(canonical);
      const dedupKey = `eci:inv:dedup:${connectionId}:${bodyHash}`;

      const existing = await redis.get(dedupKey);
      if (existing) {
        return res.json({
          ok: true,
          dedup: true,
          bodyHash,
          jobId: existing,
          originalCount,
          coalescedCount,
          dedupWindowMs: DEDUP_WINDOW_MS,
        });
      }

      // Create job row
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

      // Enqueue
      const payload = {
        items,
        __eci: {
          bodyHash,
          originalCount,
          coalescedCount,
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

      // Dedup marker only after successful enqueue.
      await redis.set(dedupKey, jobRow.id, "PX", DEDUP_WINDOW_MS);

      return res.status(202).json({
        ok: true,
        jobId: jobRow.id,
        dedup: false,
        bodyHash,
        originalCount,
        coalescedCount,
        dedupWindowMs: DEDUP_WINDOW_MS,
      });
    })
  );

  /**
   * GET /v1/inventory/batch/:batchRequestId?connectionId=...
   * - Trendyol PDF notes that inventory batch results are queried via the *product* batch result endpoint.
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

      const result = await trendyolGetProductBatchRequestResult(cfg, batchRequestId);
      return res.json(result);
    })
  );
}
