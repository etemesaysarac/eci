import type { Express, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "./prisma";
import { decryptJson } from "./lib/crypto";
import type { TrendyolConfig } from "./connectors/trendyol/client";
import {
  trendyolGetBrands,
  trendyolGetProductCategories,
  trendyolGetCategoryAttributes,
  trendyolGetProducts,
  type TrendyolProductFilterQuery,
} from "./connectors/trendyol/client";

// Sprint 9 — Product Catalog (Read Path)
// Bu dosya sadece "okuma" hattını (brands/categories/products) açar.
// DB upsert / SYNC_PRODUCTS job Phase-2'de gelecek.

function headerLower(req: Request, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v != null ? String(v) : undefined;
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

const TrendyolCfgSchema: z.ZodType<TrendyolConfig> = z
  .object({
    sellerId: z.string().min(1),
    env: z.enum(["prod", "stage"]).default("prod"),
    baseUrl: z.string().url().optional(),
    token: z.string().optional(),
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),
    agentName: z.string().optional(),
    integrationName: z.string().optional(),
    preferSapigw: z.boolean().optional(),
    timeoutMs: z.number().optional(),
  })
  .superRefine((v, ctx) => {
    const hasToken = !!(v.token && v.token.trim().length > 0);
    const hasPair = !!(v.apiKey && v.apiSecret && v.apiKey.trim().length > 0 && v.apiSecret.trim().length > 0);
    if (!hasToken && !hasPair) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "config must include token OR (apiKey + apiSecret)",
        path: ["token"],
      });
    }
  });

async function loadTrendyolConfig(req: Request): Promise<TrendyolConfig> {
  const connectionId =
    String(req.query.connectionId ?? headerLower(req, "x-connection-id") ?? "").trim();

  if (!connectionId) {
    const err: any = new Error("connectionId is required");
    err.statusCode = 400;
    err.code = "missing_connection_id";
    throw err;
  }

  const conn = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { id: true, type: true, configEnc: true },
  });

  if (!conn) {
    const err: any = new Error(`Connection not found: ${connectionId}`);
    err.statusCode = 404;
    err.code = "connection_not_found";
    throw err;
  }
  if (conn.type !== "trendyol") {
    const err: any = new Error(`Unsupported connection type: ${conn.type}`);
    err.statusCode = 400;
    err.code = "unsupported_connection_type";
    throw err;
  }

  const cfg = normalizeConfig(decryptJson<TrendyolConfig>(conn.configEnc));
  const parsed = TrendyolCfgSchema.safeParse(cfg);
  if (!parsed.success) {
    const err: any = new Error("invalid trendyol config");
    err.statusCode = 400;
    err.code = "invalid_trendyol_config";
    err.details = parsed.error.flatten();
    throw err;
  }
  return parsed.data;
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

export function registerSprint9ProductCatalogRoutes(app: Express) {
  // Brands
  app.get("/v1/trendyol/brands", async (req: Request, res: Response) => {
    try {
      const cfg = await loadTrendyolConfig(req);
      const page = parseIntParam(req.query.page, 0, 0, 2000);
      const size = parseIntParam(req.query.size, 50, 1, 200);
      const data = await trendyolGetBrands(cfg, { page, size });
      res.json(data);
    } catch (e: any) {
      const status = Number(e?.statusCode ?? 500);
      res.status(status).json({ ok: false, error: e?.code ?? "internal_error", message: String(e?.message ?? e), details: e?.details });
    }
  });

  // Category tree
  app.get("/v1/trendyol/categories", async (req: Request, res: Response) => {
    try {
      const cfg = await loadTrendyolConfig(req);
      const data = await trendyolGetProductCategories(cfg);
      res.json(data);
    } catch (e: any) {
      const status = Number(e?.statusCode ?? 500);
      res.status(status).json({ ok: false, error: e?.code ?? "internal_error", message: String(e?.message ?? e), details: e?.details });
    }
  });

  // Category attributes
  app.get("/v1/trendyol/categories/:categoryId/attributes", async (req: Request, res: Response) => {
    try {
      const cfg = await loadTrendyolConfig(req);
      const categoryId = String(req.params.categoryId ?? "").trim();
      if (!categoryId) return res.status(400).json({ ok: false, error: "missing_category_id" });
      const data = await trendyolGetCategoryAttributes(cfg, categoryId);
      res.json(data);
    } catch (e: any) {
      const status = Number(e?.statusCode ?? 500);
      res.status(status).json({ ok: false, error: e?.code ?? "internal_error", message: String(e?.message ?? e), details: e?.details });
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
      res.status(status).json({ ok: false, error: e?.code ?? "internal_error", message: String(e?.message ?? e), details: e?.details });
    }
  });
}
