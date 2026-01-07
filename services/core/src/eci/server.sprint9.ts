import type { Express, Request, Response } from "express";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { eciQueue } from "./queue";
import { loadTrendyolConfig } from "./connections";
import {
  TrendyolProductFilterQuery,
  trendyolGetBrands,
  trendyolGetProductCategories,
  trendyolGetCategoryAttributes,
  trendyolGetProducts,
} from "./connectors/trendyol/client";
import { refCacheGetOrSet, refCacheRefreshByPrefix, refCacheStatus } from "./refcache";

function refTtlMs(resource: string) {
  // Defaults tuned for "reference" data; can be overridden via env.
  const def = Number(process.env.REFCACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
  const fast = Number(process.env.REFCACHE_FAST_TTL_MS ?? 6 * 60 * 60 * 1000);
  if (resource.startsWith("brands")) return fast;
  return def;
}

function parseIntParam(v: any, def: number, min?: number, max?: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  let out = Math.trunc(n);
  if (typeof min === "number") out = Math.max(min, out);
  if (typeof max === "number") out = Math.min(max, out);
  return out;
}

function parseBoolParam(v: any): boolean | undefined {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return undefined;
}

function asNumber(v: any, def = 0) {
  if (v == null) return def;
  if (typeof v === "bigint") return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function requireConnectionId(req: Request): string | null {
  // Primary: query param
  const fromQuery = (req.query as any)?.connectionId;
  // Fallback: allow header-based passing (useful when proxies/tools mangle query parsing)
  const fromHeader = (req.headers as any)?.["x-connection-id"];
  // Last resort: parse from raw URL (should almost never be needed, but keeps us moving)
  const rawUrl = String((req as any)?.originalUrl ?? "");
  const m = /[?&]connectionId=([^&]+)/.exec(rawUrl);
  const fromUrl = m ? decodeURIComponent(m[1]) : "";

  const id = String(fromQuery ?? fromHeader ?? fromUrl ?? "").trim();
  if (!id) return null;
  return id;
}

export function registerSprint9ProductCatalogRoutes(app: Express) {
  // -----------------------------
  // Lookup / Reference data (cache-first)
  // -----------------------------

  // Brands
  app.get("/v1/trendyol/brands", async (req: Request, res: Response) => {
    try {
      const cfg = await loadTrendyolConfig(req);
      const page = parseIntParam(req.query.page, 0, 0, 2000);
      const size = parseIntParam(req.query.size, 50, 1, 200);
      const { data, source } = await refCacheGetOrSet({
        provider: "trendyol",
        scope: "GLOBAL",
        connectionId: null,
        resourceKey: `brands:${cfg.env}:seller:${cfg.sellerId}:p:${page}:s:${size}`,
        ttlMs: refTtlMs("brands"),
        fetcher: () => trendyolGetBrands(cfg, { page, size }),
      });
      res.setHeader("x-cache", source);
      res.json(data);
    } catch (e: any) {
      const status = Number(e?.statusCode ?? 500);
      res
        .status(status)
        .json({ ok: false, error: e?.code ?? "internal_error", message: String(e?.message ?? e), details: e?.details });
    }
  });

  // Category tree
  app.get("/v1/trendyol/categories", async (req: Request, res: Response) => {
    try {
      const cfg = await loadTrendyolConfig(req);
      const { data, source } = await refCacheGetOrSet({
        provider: "trendyol",
        scope: "GLOBAL",
        connectionId: null,
        resourceKey: `categories:${cfg.env}:seller:${cfg.sellerId}`,
        ttlMs: refTtlMs("categories"),
        fetcher: () => trendyolGetProductCategories(cfg),
      });
      res.setHeader("x-cache", source);
      res.json(data);
    } catch (e: any) {
      const status = Number(e?.statusCode ?? 500);
      res
        .status(status)
        .json({ ok: false, error: e?.code ?? "internal_error", message: String(e?.message ?? e), details: e?.details });
    }
  });

  // Category attributes
  app.get("/v1/trendyol/categories/:categoryId/attributes", async (req: Request, res: Response) => {
    try {
      const cfg = await loadTrendyolConfig(req);
      const categoryId = String(req.params.categoryId ?? "").trim();
      if (!categoryId) return res.status(400).json({ ok: false, error: "missing_category_id" });

      const { data, source } = await refCacheGetOrSet({
        provider: "trendyol",
        scope: "GLOBAL",
        connectionId: null,
        resourceKey: `catAttrs:${cfg.env}:seller:${cfg.sellerId}:cat:${categoryId}`,
        ttlMs: refTtlMs(`catAttrs:${categoryId}`),
        fetcher: () => trendyolGetCategoryAttributes(cfg, categoryId),
      });

      res.setHeader("x-cache", source);
      res.json(data);
    } catch (e: any) {
      const status = Number(e?.statusCode ?? 500);
      res
        .status(status)
        .json({ ok: false, error: e?.code ?? "internal_error", message: String(e?.message ?? e), details: e?.details });
    }
  });

  // Category attribute values (derived from /attributes payload)
  app.get("/v1/trendyol/categories/:categoryId/attributes/:attributeId/values", async (req: Request, res: Response) => {
    try {
      const cfg = await loadTrendyolConfig(req);
      const categoryId = String(req.params.categoryId ?? "").trim();
      const attributeId = String(req.params.attributeId ?? "").trim();
      if (!categoryId) return res.status(400).json({ ok: false, error: "missing_category_id" });
      if (!attributeId) return res.status(400).json({ ok: false, error: "missing_attribute_id" });

      const { data, source } = await refCacheGetOrSet({
        provider: "trendyol",
        scope: "GLOBAL",
        connectionId: null,
        resourceKey: `catAttrs:${cfg.env}:seller:${cfg.sellerId}:cat:${categoryId}`,
        ttlMs: refTtlMs(`catAttrs:${categoryId}`),
        fetcher: () => trendyolGetCategoryAttributes(cfg, categoryId),
      });

      const attrs = (data as any)?.categoryAttributes ?? (data as any)?.attributes ?? [];
      const attr = Array.isArray(attrs)
        ? attrs.find((x: any) => String(x?.attribute?.id ?? "") === attributeId)
        : undefined;

      if (!attr) return res.status(404).json({ ok: false, error: "attribute_not_found" });

      res.setHeader("x-cache", source);
      res.json({
        ok: true,
        categoryId,
        attributeId,
        attributeName: attr?.attribute?.name,
        values: attr?.attributeValues ?? [],
        meta: {
          required: !!attr?.required,
          allowCustom: !!attr?.allowCustom,
          variant: !!attr?.variant,
          slicer: !!attr?.slicer,
        },
      });
    } catch (e: any) {
      const status = Number(e?.statusCode ?? 500);
      res
        .status(status)
        .json({ ok: false, error: e?.code ?? "internal_error", message: String(e?.message ?? e), details: e?.details });
    }
  });

  // Product filter/list (Trendyol proxy)
  app.get("/v1/trendyol/products", async (req: Request, res: Response) => {
    try {
      const cfg = await loadTrendyolConfig(req);
      const q: TrendyolProductFilterQuery = {
        approved: parseBoolParam(req.query.approved),
        page: parseIntParam(req.query.page, 0, 0, 2000),
        size: parseIntParam(req.query.size, 50, 1, 200),
        barcode: req.query.barcode != null ? String(req.query.barcode).trim() : undefined,
        productCode: req.query.productCode != null ? String(req.query.productCode).trim() : undefined,
      };
      const data = await trendyolGetProducts(cfg, q);
      res.json(data);
    } catch (e: any) {
      const status = Number(e?.statusCode ?? 500);
      res
        .status(status)
        .json({ ok: false, error: e?.code ?? "internal_error", message: String(e?.message ?? e), details: e?.details });
    }
  });

  // -----------------------------
  // Product catalog (DB read) — Panel data source
  // -----------------------------

  // Batch list MUST be defined before /v1/products/:id (route shadowing)
  app.get("/v1/products/batches", async (req: Request, res: Response) => {
    try {
      res.setHeader("x-eci-sprint9", "products-v14");

      const connectionId = requireConnectionId(req);
      if (!connectionId) return res.status(400).json({ ok: false, error: "missing_connectionId" });

      const page = parseIntParam(req.query.page, 0, 0, 2000);
      const size = parseIntParam(req.query.size, 50, 1, 200);
      const offset = page * size;

      const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT
          "id","connectionId","marketplace","type","remoteBatchId","status","payloadSummary","errors","createdAt","updatedAt"
        FROM "ProductBatchRequest"
        WHERE "connectionId" = ${connectionId}
        ORDER BY "createdAt" DESC
        LIMIT ${size} OFFSET ${offset};
      `);

      const totalRows = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "count"
        FROM "ProductBatchRequest"
        WHERE "connectionId" = ${connectionId};
      `);

      const total = asNumber(totalRows?.[0]?.count, 0);

      res.json({ ok: true, page, size, total, items: rows });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: "internal_error", message: String(e?.message ?? e) });
    }
  });

  app.get("/v1/products/batches/:id", async (req: Request, res: Response) => {
    try {
      res.setHeader("x-eci-sprint9", "products-v14");

      const connectionId = requireConnectionId(req);
      if (!connectionId) return res.status(400).json({ ok: false, error: "missing_connectionId" });

      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

      const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT
          "id","connectionId","marketplace","type","remoteBatchId","status","payloadSummary","errors","createdAt","updatedAt"
        FROM "ProductBatchRequest"
        WHERE "id" = ${id} AND "connectionId" = ${connectionId}
        LIMIT 1;
      `);

      const row = rows?.[0];
      if (!row) return res.status(404).json({ ok: false, error: "not_found" });

      res.json({ ok: true, item: row });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: "internal_error", message: String(e?.message ?? e) });
    }
  });

  // Panel product list (reads from Product + ProductVariant)
  app.get("/v1/products", async (req: Request, res: Response) => {
    try {
      res.setHeader("x-eci-sprint9", "products-v14");

      const connectionId = requireConnectionId(req);
      if (!connectionId) return res.status(400).json({ ok: false, error: "missing_connectionId" });

      const page = parseIntParam(req.query.page, 0, 0, 2000);
      const size = parseIntParam(req.query.size, 50, 1, 200);
      const offset = page * size;

      const approved = parseBoolParam(req.query.approved);
const archived = parseBoolParam(req.query.archived);
const brandId = req.query.brandId != null ? parseIntParam(req.query.brandId, -1, -1) : undefined;
const categoryId = req.query.categoryId != null ? parseIntParam(req.query.categoryId, -1, -1) : undefined;
const q = req.query.q != null ? String(req.query.q).trim() : "";
const includeVariants = parseBoolParam(req.query.includeVariants) ?? false;

// NOTE: We build WHERE incrementally (instead of Prisma.join([...])) to avoid
// "syntax error at or near Object" issues seen with some Prisma + queryRaw combos.
let whereSql = Prisma.sql`WHERE p."connectionId" = ${connectionId}`;

// Sprint 9 schema alignment ensures this column exists (older DBs may miss it).
whereSql = Prisma.sql`${whereSql} AND p."marketplace" = ${"trendyol"}`;

if (approved !== undefined) whereSql = Prisma.sql`${whereSql} AND p."approved" = ${approved}`;
if (archived !== undefined) whereSql = Prisma.sql`${whereSql} AND p."archived" = ${archived}`;
if (typeof brandId === "number" && brandId >= 0) whereSql = Prisma.sql`${whereSql} AND p."brandId" = ${brandId}`;
if (typeof categoryId === "number" && categoryId >= 0) whereSql = Prisma.sql`${whereSql} AND p."categoryId" = ${categoryId}`;

if (q) {
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  whereSql = Prisma.sql`${whereSql} AND (
    COALESCE(p."title",'') ILIKE ${like}
    OR COALESCE(p."productCode",'') ILIKE ${like}
    OR COALESCE(p."primaryBarcode",'') ILIKE ${like}
  )`;
}

const totalRows = await prisma.$queryRaw<any[]>(Prisma.sql`
  SELECT COUNT(*)::bigint AS "count"
  FROM "Product" p
  ${whereSql};
`);
const total = asNumber(totalRows?.[0]?.count, 0);

const items = await prisma.$queryRaw<any[]>(Prisma.sql`
  SELECT
    p.*,
    (
      SELECT COUNT(*)::int
      FROM "ProductVariant" v
      WHERE v."productId" = p."id"
    ) AS "variantCount"
  FROM "Product" p
  ${whereSql}
  ORDER BY p."updatedAt" DESC
  LIMIT ${size} OFFSET ${offset};
`);

      if (!includeVariants || items.length === 0) {
        return res.json({ ok: true, page, size, total, items });
      }

      const ids = items.map((x) => x.id).filter(Boolean);
      const variants = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT
          "id","connectionId","productId","marketplace","barcode","stock","listPrice","salePrice","currency","raw","createdAt","updatedAt"
        FROM "ProductVariant"
        WHERE "connectionId" = ${connectionId}
          AND "productId" IN (${Prisma.join(ids)})
        ORDER BY "updatedAt" DESC;
      `);

      const byProduct: Record<string, any[]> = {};
      for (const v of variants) {
        const pid = String(v.productId);
        byProduct[pid] = byProduct[pid] ?? [];
        byProduct[pid].push(v);
      }

      const hydrated = items.map((p) => ({ ...p, variants: byProduct[String(p.id)] ?? [] }));
      res.json({ ok: true, page, size, total, items: hydrated });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: "internal_error", message: String(e?.message ?? e) });
    }
  });

  // Single product details (with variants)
  app.get("/v1/products/:id", async (req: Request, res: Response) => {
    try {
      res.setHeader("x-eci-sprint9", "products-v14");

      const connectionId = requireConnectionId(req);
      if (!connectionId) return res.status(400).json({ ok: false, error: "missing_connectionId" });

      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

      const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT *
        FROM "Product"
        WHERE "id" = ${id}
          AND "connectionId" = ${connectionId}
        LIMIT 1;
      `);

      const item = rows?.[0];
      if (!item) return res.status(404).json({ ok: false, error: "not_found" });

      const variants = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT
          "id","connectionId","productId","marketplace","barcode","stock","listPrice","salePrice","currency","raw","createdAt","updatedAt"
        FROM "ProductVariant"
        WHERE "connectionId" = ${connectionId}
          AND "productId" = ${id}
        ORDER BY "updatedAt" DESC;
      `);

      res.json({ ok: true, item: { ...item, variants } });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: "internal_error", message: String(e?.message ?? e) });
    }
  });

  // -----------------------------
  // Sprint 9.3 — Write Path (push product + refresh batch)
  // -----------------------------

  // Push one DB product to Trendyol (create/update) — creates a local batch row + enqueues worker job
  app.post("/v1/products/:id/push", async (req: Request, res: Response) => {
    try {
      res.setHeader("x-eci-sprint9", "products-v14");

      const connectionId = requireConnectionId(req);
      if (!connectionId) return res.status(400).json({ ok: false, error: "missing_connectionId" });

      const productId = String(req.params.id ?? "").trim();
      if (!productId) return res.status(400).json({ ok: false, error: "missing_productId" });

      // Ensure product exists (DB)
      const exists = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT "id" FROM "Product"
        WHERE "connectionId"=${connectionId} AND "id"=${productId}
        LIMIT 1;
      `);
      if (!exists?.length) return res.status(404).json({ ok: false, error: "product_not_found" });

      const batchLocalId = randomUUID();

      // Create local batch row immediately (so UI can poll right away)
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "ProductBatchRequest"
          ("id","connectionId","marketplace","type","remoteBatchId","status","payloadSummary","errors","createdAt","updatedAt")
        VALUES
          (
            ${batchLocalId},
            ${connectionId},
            ${"trendyol"},
            ${"PUSH_PRODUCT"},
            ${null},
            ${"CREATED"},
            ${JSON.stringify({ productId, note: "queued" })}::jsonb,
            ${null}::jsonb,
            NOW(),
            NOW()
          );
      `);

      const jobRow = await prisma.job.create({
        data: { connectionId, type: "TRENDYOL_PUSH_PRODUCT", status: "queued" },
        select: { id: true },
      });

      const overridePayload =
        req.body && typeof req.body === "object" && Object.keys(req.body as any).length ? req.body : null;

      await eciQueue.add(
        "TRENDYOL_PUSH_PRODUCT",
        { jobId: jobRow.id, connectionId, params: { productId, batchLocalId, overridePayload } },
        { attempts: 5, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: true, removeOnFail: false }
      );

      res.json({ ok: true, jobId: jobRow.id, batchLocalId });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: "internal_error", message: String(e?.message ?? e) });
    }
  });

  // Refresh batch status from Trendyol (remoteBatchId -> latest status/errors)
  app.post("/v1/products/batches/:id/refresh", async (req: Request, res: Response) => {
    try {
      res.setHeader("x-eci-sprint9", "products-v14");

      const connectionId = requireConnectionId(req);
      if (!connectionId) return res.status(400).json({ ok: false, error: "missing_connectionId" });

      const batchLocalId = String(req.params.id ?? "").trim();
      if (!batchLocalId) return res.status(400).json({ ok: false, error: "missing_batchLocalId" });

      const exists = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT "id" FROM "ProductBatchRequest"
        WHERE "connectionId"=${connectionId} AND "id"=${batchLocalId}
        LIMIT 1;
      `);
      if (!exists?.length) return res.status(404).json({ ok: false, error: "batch_not_found" });

      // Touch batch row (optional)
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "ProductBatchRequest" SET "updatedAt"=NOW(), "status"=${"REFRESH_QUEUED"}
        WHERE "id"=${batchLocalId} AND "connectionId"=${connectionId};
      `);

      const jobRow = await prisma.job.create({
        data: { connectionId, type: "TRENDYOL_REFRESH_PRODUCT_BATCH", status: "queued" },
        select: { id: true },
      });

      await eciQueue.add(
        "TRENDYOL_REFRESH_PRODUCT_BATCH",
        { jobId: jobRow.id, connectionId, params: { batchLocalId } },
        { attempts: 10, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: true, removeOnFail: false }
      );

      res.json({ ok: true, jobId: jobRow.id, batchLocalId });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: "internal_error", message: String(e?.message ?? e) });
    }
  });


  // -----------------------------
  // Reference cache (debug/admin)
  // -----------------------------
  app.get("/v1/refcache/status", async (_req: Request, res: Response) => {
    try {
      const out = await refCacheStatus(50);
      res.json({ ok: true, ...out });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: "internal_error", message: String(e?.message ?? e) });
    }
  });

  app.post("/v1/refcache/refresh", async (req: Request, res: Response) => {
    try {
      const provider = String(req.body?.provider ?? "trendyol").trim();
      const prefix = String(req.body?.prefix ?? "").trim();
      if (!prefix) return res.status(400).json({ ok: false, error: "missing_prefix" });
      const out = await refCacheRefreshByPrefix(provider, prefix);
      res.json({ ok: true, ...out });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: "internal_error", message: String(e?.message ?? e) });
    }
  });
}
