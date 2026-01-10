/*
Sprint 9 — Product Katalog (READ PATH + SYNC JOB)
=================================================
Goals (Sprint 9 / Phase 1):
- Trendyol lookups (brands, categories, attributes, values) as read-only proxy endpoints
- Product sync job (Trendyol -> DB)
- Panel read endpoints (GET /v1/products, GET /v1/products/:id)

Notes:
- We intentionally avoid Redis sync locks for products in this first iteration.
  We gate concurrent sync via DB job status checks (queued/running/retrying).
*/

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "./prisma";
import { decryptJson } from "./lib/crypto";
import { eciQueue } from "./queue";
import type { TrendyolConfig } from "./connectors/trendyol/client";
import {
  trendyolGetBrands,
  trendyolGetCategoryTree,
  trendyolGetCategoryAttributes,
  trendyolGetCategoryAttributeValues,
  trendyolListApprovedProducts,
  trendyolListUnapprovedProducts,
  trendyolGetProductBatchRequestResult,
} from "./connectors/trendyol/client";

// Express 4 does NOT automatically catch async errors.
// Without this wrapper, a thrown error inside an async route can crash the process.
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
    message: "token OR apiKey+apiSecret required",
    path: ["token"],
  });

async function loadTrendyolConfig(connectionId: string): Promise<TrendyolConfig> {
  const conn = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { id: true, type: true, configEnc: true, status: true },
  });

  if (!conn) throw new Error("connection not found");
  if (conn.type !== "trendyol") throw new Error(`unsupported connection type: ${conn.type}`);

  const cfg = normalizeConfig(decryptJson<TrendyolConfig>(conn.configEnc));
  const parsed = TrendyolConfigSchema.safeParse(cfg);
  if (!parsed.success) {
    throw new Error("connection config invalid: " + JSON.stringify(parsed.error.flatten()));
  }
  return parsed.data;
}

const SyncProductsSchema = z
  .object({
    pageSize: z.number().int().min(1).max(200).optional(),
    maxPages: z.number().int().min(1).max(500).optional(),
    includeApproved: z.boolean().optional(),
    includeUnapproved: z.boolean().optional(),
  })
  .strict()
  .optional();

const PushProductsActionQuerySchema = z.object({
  action: z.enum(["create", "update"]),
});

// Shallow validation: enforce only the general request shape.
// Trendyol create/update APIs allow max 1000 items per request.
const PushProductsBodySchema = z
  .object({
    items: z.array(z.any()).min(1).max(1000),
  })
  .passthrough();

export function registerSprint9ProductRoutes(app: Express) {
  // -----------------------------
  // Lookups (read-only proxy)
  // -----------------------------

  app.get("/v1/trendyol/brands", asyncHandler(async (req: Request, res: Response) => {
    const connectionId = String(req.query.connectionId ?? "").trim();
    if (!connectionId) return res.status(400).json({ error: "connectionId required" });

    const page = req.query.page != null ? Number(req.query.page) : undefined;
    const size = req.query.size != null ? Number(req.query.size) : undefined;

    const cfg = await loadTrendyolConfig(connectionId);
    const data = await trendyolGetBrands(cfg, { page, size });
    res.json(data);
  }));

  app.get("/v1/trendyol/categories", asyncHandler(async (req: Request, res: Response) => {
    const connectionId = String(req.query.connectionId ?? "").trim();
    if (!connectionId) return res.status(400).json({ error: "connectionId required" });

    const cfg = await loadTrendyolConfig(connectionId);
    const data = await trendyolGetCategoryTree(cfg);
    res.json(data);
  }));

  app.get("/v1/trendyol/categories/:categoryId/attributes", asyncHandler(async (req: Request, res: Response) => {
    const connectionId = String(req.query.connectionId ?? "").trim();
    if (!connectionId) return res.status(400).json({ error: "connectionId required" });

    const categoryId = String(req.params.categoryId ?? "").trim();
    if (!categoryId) return res.status(400).json({ error: "categoryId required" });

    const cfg = await loadTrendyolConfig(connectionId);
    const data = await trendyolGetCategoryAttributes(cfg, categoryId);
    res.json(data);
  }));

  app.get(
    "/v1/trendyol/categories/:categoryId/attributes/:attributeId/values",
    asyncHandler(async (req: Request, res: Response) => {
      const connectionId = String(req.query.connectionId ?? "").trim();
      if (!connectionId) return res.status(400).json({ error: "connectionId required" });

      const categoryId = String(req.params.categoryId ?? "").trim();
      const attributeId = String(req.params.attributeId ?? "").trim();
      if (!categoryId || !attributeId) return res.status(400).json({ error: "categoryId and attributeId required" });

      const cfg = await loadTrendyolConfig(connectionId);
      const data = await trendyolGetCategoryAttributeValues(cfg, categoryId, attributeId);
      res.json(data);
    })
  );

  // Optional helpers for debugging: list products directly from Trendyol (without DB)
  app.get("/v1/trendyol/products/approved", asyncHandler(async (req: Request, res: Response) => {
    const connectionId = String(req.query.connectionId ?? "").trim();
    if (!connectionId) return res.status(400).json({ error: "connectionId required" });

    const page = req.query.page != null ? Number(req.query.page) : undefined;
    const size = req.query.size != null ? Number(req.query.size) : undefined;

    const cfg = await loadTrendyolConfig(connectionId);
    const data = await trendyolListApprovedProducts(cfg, { page, size });
    res.json(data);
  }));

  app.get("/v1/trendyol/products/unapproved", asyncHandler(async (req: Request, res: Response) => {
    const connectionId = String(req.query.connectionId ?? "").trim();
    if (!connectionId) return res.status(400).json({ error: "connectionId required" });

    const page = req.query.page != null ? Number(req.query.page) : undefined;
    const size = req.query.size != null ? Number(req.query.size) : undefined;

    const cfg = await loadTrendyolConfig(connectionId);
    const data = await trendyolListUnapprovedProducts(cfg, { page, size });
    res.json(data);
  }));

  app.get("/v1/trendyol/products/batch-requests/:batchRequestId", asyncHandler(async (req: Request, res: Response) => {
    const batchRequestId = String(req.params.batchRequestId ?? "").trim();
    if (!batchRequestId) return res.status(400).json({ error: "batchRequestId required" });

    // Prefer explicit connectionId, but if omitted, try to infer from our DB by remoteBatchId.
    // This makes manual testing and panel UX simpler (no need to pass connectionId for known batches).
    let connectionId = String(req.query.connectionId ?? "").trim();
    if (!connectionId) {
      const row = await prisma.productBatchRequest.findFirst({
        where: { remoteBatchId: batchRequestId },
        select: { connectionId: true },
        orderBy: { createdAt: "desc" },
      });
      if (row?.connectionId) connectionId = row.connectionId;
    }
    if (!connectionId) return res.status(400).json({ error: "connectionId required" });

    const cfg = await loadTrendyolConfig(connectionId);
    const data = await trendyolGetProductBatchRequestResult(cfg, batchRequestId);
    res.json(data);
  }));

  // -----------------------------
  // Commands
  // -----------------------------
  app.post("/v1/connections/:id/sync/products", asyncHandler(async (req: Request, res: Response) => {
    const connectionId = String(req.params.id ?? "").trim();
    if (!connectionId) return res.status(400).json({ error: "connectionId required" });

    const conn = await prisma.connection.findUnique({
      where: { id: connectionId },
      select: { id: true, type: true },
    });

    if (!conn) return res.status(404).json({ error: "not_found" });
    if (conn.type !== "trendyol") return res.status(400).json({ error: "only trendyol supported for now" });

    const bodyParsed = SyncProductsSchema.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: bodyParsed.error.flatten() });

    const active = await prisma.job.findFirst({
      where: {
        connectionId,
        type: "TRENDYOL_SYNC_PRODUCTS",
        status: { in: ["queued", "running", "retrying"] },
      },
      select: { id: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    if (active) {
      return res.status(409).json({
        error: "sync_in_progress",
        connectionId,
        jobId: active.id,
        status: active.status,
        createdAt: active.createdAt,
      });
    }

    const jobRow = await prisma.job.create({
      data: { connectionId, type: "TRENDYOL_SYNC_PRODUCTS", status: "queued" },
      select: { id: true },
    });

    await eciQueue.add(
      "TRENDYOL_SYNC_PRODUCTS",
      { jobId: jobRow.id, connectionId, params: bodyParsed.data ?? null },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 50,
        removeOnFail: 200,
      }
    );

    res.json({ jobId: jobRow.id });
  }));

  // Product create/update (V2) — enqueue only. Worker performs the actual call.
  // POST /v1/connections/:id/push/products?action=create|update
  app.post("/v1/connections/:id/push/products", asyncHandler(async (req: Request, res: Response) => {
    const connectionId = String(req.params.id ?? "").trim();
    if (!connectionId) return res.status(400).json({ error: "connectionId required" });

    const conn = await prisma.connection.findUnique({
      where: { id: connectionId },
      select: { id: true, type: true },
    });
    if (!conn) return res.status(404).json({ error: "not_found" });
    if (conn.type !== "trendyol") return res.status(400).json({ error: "only trendyol supported for now" });

    const queryParsed = PushProductsActionQuerySchema.safeParse({
      action: String(req.query.action ?? "").trim(),
    });
    if (!queryParsed.success) return res.status(400).json({ error: queryParsed.error.flatten() });

    const bodyParsed = PushProductsBodySchema.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: bodyParsed.error.flatten() });

    const active = await prisma.job.findFirst({
      where: {
        connectionId,
        type: "TRENDYOL_PUSH_PRODUCTS",
        status: { in: ["queued", "running", "retrying"] },
      },
      select: { id: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    if (active) {
      return res.status(409).json({
        error: "push_in_progress",
        connectionId,
        jobId: active.id,
        status: active.status,
        createdAt: active.createdAt,
      });
    }

    const jobRow = await prisma.job.create({
      data: { connectionId, type: "TRENDYOL_PUSH_PRODUCTS", status: "queued" },
      select: { id: true },
    });

    await eciQueue.add(
      "TRENDYOL_PUSH_PRODUCTS",
      {
        jobId: jobRow.id,
        connectionId,
        push: { action: queryParsed.data.action },
        payload: bodyParsed.data,
      },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 50,
        removeOnFail: 200,
      }
    );

    res.json({ jobId: jobRow.id, action: queryParsed.data.action });
  }));

  // -----------------------------
  // Panel read endpoints (DB)
  // -----------------------------

  app.get("/v1/products", asyncHandler(async (req: Request, res: Response) => {
    const connectionId = String(req.query.connectionId ?? "").trim();
    const q = String(req.query.q ?? "").trim();

    const approvedRaw = req.query.approved;
    const archivedRaw = req.query.archived;
    const statusRaw = String(req.query.status ?? "").trim();

    const page = Math.max(0, Number(req.query.page ?? 0) || 0);
    const size = Math.min(200, Math.max(1, Number(req.query.size ?? 50) || 50));

    const where: any = {};
    if (connectionId) where.connectionId = connectionId;
    if (statusRaw) where.status = statusRaw;

    if (approvedRaw != null && String(approvedRaw).trim() !== "") {
      where.approved = String(approvedRaw).toLowerCase() === "true";
    }
    if (archivedRaw != null && String(archivedRaw).trim() !== "") {
      where.archived = String(archivedRaw).toLowerCase() === "true";
    }

    if (q) {
      where.OR = [
        { productCode: { contains: q, mode: "insensitive" } },
        { title: { contains: q, mode: "insensitive" } },
        { primaryBarcode: { contains: q, mode: "insensitive" } },
      ];
    }

    const [total, items] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: page * size,
        take: size,
        include: {
          variants: {
            orderBy: { updatedAt: "desc" },
            take: 20,
          },
        },
      }),
    ]);

    res.json({ page, size, total, items });
  }));

  app.get("/v1/products/:id", asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "id required" });

    const row = await prisma.product.findUnique({
      where: { id },
      include: { variants: { orderBy: { updatedAt: "desc" } } },
    });

    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  }));
}
