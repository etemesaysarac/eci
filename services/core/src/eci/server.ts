import "dotenv/config";
import { registerSprint7ActionRoutes } from "./server.sprint7";
import { registerSprint8WebhookRoutes } from "./server.sprint8";

import express, { type Request, type Response, type NextFunction } from "express";
import IORedis from "ioredis";
import { randomUUID } from "crypto";
import { z, type RefinementCtx } from "zod";
import { eciQueue } from "./queue";
import { prisma } from "./prisma";
import { decryptJson, encryptJson } from "./lib/crypto";
import { trendyolProbeShipmentPackages, type TrendyolConfig } from "./connectors/trendyol/client";

process.on("unhandledRejection", (e: unknown) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e: unknown) => console.error("[uncaughtException]", e));

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const SYNC_LOCK_TTL_MS = Number(process.env.SYNC_LOCK_TTL_MS ?? 60 * 60 * 1000);
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

function syncLockKey(connectionId: string) {
  return `eci:sync:lock:${connectionId}`;
}

const app = express();
// Keep raw body for webhook verification (Sprint 8)
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);
registerSprint7ActionRoutes(app);
registerSprint8WebhookRoutes(app);

// Express 4 does NOT automatically catch async errors.
// Without this wrapper, a thrown error inside an async route can crash the process.
const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any> | any) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);


app.get("/", (_req: Request, res: Response) => res.status(200).send("ECI Core OK"));
app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

// Sprint 8 helper: allow GET/HEAD checks for webhook URL validation (Trendyol may verify reachability).
// POST is still protected by x-api-key / Basic auth inside server.sprint8.ts.
app.get("/v1/webhooks/trendyol", (_req: Request, res: Response) => res.status(200).json({ ok: true }));
app.head("/v1/webhooks/trendyol", (_req: Request, res: Response) => res.sendStatus(200));
app.get("/v1/webhooks/orders", (_req: Request, res: Response) => res.status(200).json({ ok: true }));
app.head("/v1/webhooks/orders", (_req: Request, res: Response) => res.sendStatus(200));


// -----------------------------
// Schemas
// -----------------------------

const TrendyolConfigSchema: z.ZodType<TrendyolConfig> = z
  .object({
    sellerId: z.string().min(1),
    env: z.enum(["prod", "stage"]).default("prod"),

    baseUrl: z.string().url().optional(),

    token: z.string().optional(),
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),

    agentName: z.string().default("SoXYZ"),
    integrationName: z.string().default("SoXYZ-ECI"),

    preferSapigw: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .superRefine((cfg: TrendyolConfig, ctx: RefinementCtx) => {
    const hasToken = !!(cfg.token && cfg.token.trim());
    const hasPair = !!(cfg.apiKey && cfg.apiSecret);
    if (!hasToken && !hasPair) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "config must include token OR (apiKey + apiSecret)",
        path: ["token"],
      });
    }
  });

const CreateConnectionSchema = z.object({
  type: z.enum(["trendyol"]),
  name: z.string().min(1),
  config: TrendyolConfigSchema,
});

const SyncOrdersSchema = z
  .object({
    status: z.string().optional(),
    startDate: z.number().int().optional(),
    endDate: z.number().int().optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  })
  .optional();

function mask(s?: string) {
  if (!s) return s;
  if (s.length <= 8) return "****";
  return s.slice(0, 4) + "â€¦" + s.slice(-4);
}

function sanitizeConfig(cfg: TrendyolConfig) {
  return {
    ...cfg,
    token: cfg.token ? mask(cfg.token) : undefined,
    apiKey: cfg.apiKey ? mask(cfg.apiKey) : undefined,
    apiSecret: cfg.apiSecret ? mask(cfg.apiSecret) : undefined,
  };
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
    // "Basic <base64>" gelirse sadece base64 kÄ±smÄ±nÄ± saklÄ±yoruz.
    token: tokenRaw ? tokenRaw.replace(/^Basic\s+/i, "").trim() : undefined,
    apiKey,
    apiSecret,
    agentName: String(cfg.agentName ?? "SoXYZ").trim(),
    integrationName: String(cfg.integrationName ?? "SoXYZ-ECI").trim(),
    baseUrl: baseUrlRaw ? baseUrlRaw.replace(/\/+$/, "") : undefined,
  };
}


// -----------------------------
// Connection routes
// -----------------------------

app.post("/v1/connections", asyncHandler(async (req: Request, res: Response) => {
  const parsed = CreateConnectionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { type, name, config } = parsed.data;

  const configEnc = encryptJson(normalizeConfig(config));

  const connection = await prisma.connection.create({
    data: {
      type,
      name,
      status: "active",
      configEnc,
    },
    select: { id: true },
  });

  res.json({ id: connection.id });
}));

app.get("/v1/connections", asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.connection.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, name: true, status: true, createdAt: true, updatedAt: true },
  });
  res.json(rows);
}));

app.get("/v1/connections/:id/status", asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;

  const conn = await prisma.connection.findUnique({
    where: { id },
    select: { id: true, type: true, name: true, status: true, createdAt: true, updatedAt: true },
  });

  if (!conn) return res.status(404).json({ error: "not_found" });

  const state = await prisma.syncState.findUnique({
    where: { connectionId: id },
    select: { lastAttemptAt: true, lastSuccessAt: true, lastStatus: true, lastJobId: true, lastError: true, updatedAt: true },
  });

  const lastJob = await prisma.job.findFirst({
    where: { connectionId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, status: true, startedAt: true, finishedAt: true, summary: true, error: true, createdAt: true },
  });

  res.json({ connection: conn, state, lastJob });
}));

app.post("/v1/connections/:id/test", asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;

  const conn = await prisma.connection.findUnique({
    where: { id },
    select: { id: true, type: true, name: true, configEnc: true, status: true },
  });

  if (!conn) return res.status(404).json({ error: "connection not found" });
  if (conn.type !== "trendyol") return res.status(400).json({ error: `unsupported connection type: ${conn.type}` });

  let cfg: TrendyolConfig;
  try {
    cfg = normalizeConfig(decryptJson<TrendyolConfig>(conn.configEnc));
  } catch (e: any) {
    return res.status(500).json({ error: `configEnc decrypt failed: ${String(e?.message ?? e)}` });
  }

  const cfgParsed = TrendyolConfigSchema.safeParse(cfg);
  if (!cfgParsed.success) return res.status(400).json({ error: cfgParsed.error.flatten() });

  const probe = await trendyolProbeShipmentPackages(cfgParsed.data);

  const results = (probe as any)?.results ?? [];
  const primary = results.find((r: any) => String(r?.url ?? "").includes("/orders"));
  const legacy  = results.find((r: any) => String(r?.url ?? "").includes("/shipment-packages"));

  const warnings: any[] = [];
  if (legacy && legacy.status !== 200) {
    warnings.push({
      key: "shipment-packages-legacy",
      status: legacy.status,
      note: "Legacy shipment-packages endpoint is returning non-200. That can be expected; /orders is the primary health signal.",
    });
  }

  const ok = primary?.status === 200;

  res.json({
    ok,
    connection: { id: conn.id, name: conn.name, status: conn.status, config: sanitizeConfig(cfgParsed.data) },
    probe: { ...probe, primary, warnings },
  });

}));

// -----------------------------
// Jobs + data routes
// -----------------------------

// Sprint 2: GerÃ§ekte /orders Ã§ekiyoruz. Endpoint'i netleÅŸtirelim.
app.post("/v1/connections/:id/sync/orders", asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;

  const conn = await prisma.connection.findUnique({
    where: { id },
    select: { id: true, type: true },
  });

  if (!conn) return res.status(404).json({ error: "not_found" });
  if (conn.type !== "trendyol") return res.status(400).json({ error: "only trendyol supported for now" });

  const payloadParsed = SyncOrdersSchema?.safeParse(req.body);
  if (payloadParsed && !payloadParsed.success) {
    return res.status(400).json({ error: payloadParsed.error.flatten() });
  }

  const body = payloadParsed?.success ? payloadParsed.data ?? undefined : undefined;

  // Concurrency guard: connection bazlÄ± tek aktif sync
  const lockKey = syncLockKey(id);
  const pending = `pending:${randomUUID()}`;
  const acquired = await redis.set(lockKey, pending, "PX", SYNC_LOCK_TTL_MS, "NX");
  if (acquired !== "OK") {
    const active = await prisma.job.findFirst({
      where: {
        connectionId: id,
        type: "TRENDYOL_SYNC_ORDERS",
        status: { in: ["queued", "running", "retrying"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, createdAt: true },
    });

    return res.status(409).json({
      error: "sync_in_progress",
      connectionId: id,
      jobId: active?.id,
      status: active?.status,
      createdAt: active?.createdAt,
    });
  }

  let jobRow: { id: string } | null = null;
  try {
    jobRow = await prisma.job.create({
      data: {
        connectionId: id,
        type: "TRENDYOL_SYNC_ORDERS",
        status: "queued",
      },
      select: { id: true },
    });

    // lock owner'Ä± gerÃ§ek jobId yapalÄ±m (worker release edebilsin)
    await redis.set(lockKey, jobRow.id, "PX", SYNC_LOCK_TTL_MS);

    await eciQueue.add(
      "TRENDYOL_SYNC_ORDERS",
      { jobId: jobRow.id, connectionId: id, params: body ?? null },
      {
        // Stabilizasyon: bir hata oldu diye direkt "failed" olmasÄ±n.
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      }
    );

    return res.json({ jobId: jobRow.id });
  } catch (e: any) {
    // enqueue/create sÄ±rasÄ±nda hata olursa lock'u bÄ±rak
    await redis.del(lockKey);
    if (jobRow?.id) {
      await prisma.job.update({
        where: { id: jobRow.id },
        data: { status: "failed", finishedAt: new Date(), error: String(e?.message ?? e) },
      });
    }
    throw e;
  }
}));

// Backward-compat: eski route'Ä± kÄ±rmayalÄ±m. (Deprecated)
app.post("/v1/connections/:id/sync/shipment-packages", asyncHandler(async (req: Request, res: Response) => {
  // Deprecated: eski route. ArtÄ±k orders sync ile aynÄ± iÅŸi yapÄ±yoruz.
  const id = req.params.id;

  const conn = await prisma.connection.findUnique({
    where: { id },
    select: { id: true, type: true },
  });

  if (!conn) return res.status(404).json({ error: "not_found" });
  if (conn.type !== "trendyol") return res.status(400).json({ error: "only trendyol supported for now" });

  const payloadParsed = SyncOrdersSchema?.safeParse(req.body);
  if (payloadParsed && !payloadParsed.success) {
    return res.status(400).json({ error: payloadParsed.error.flatten() });
  }

  const body = payloadParsed?.success ? payloadParsed.data ?? undefined : undefined;

  // Concurrency guard: connection bazlÄ± tek aktif sync
  const lockKey = syncLockKey(id);
  const pending = `pending:${randomUUID()}`;
  const acquired = await redis.set(lockKey, pending, "PX", SYNC_LOCK_TTL_MS, "NX");
  if (acquired !== "OK") {
    const active = await prisma.job.findFirst({
      where: {
        connectionId: id,
        type: { in: ["TRENDYOL_SYNC_ORDERS", "TRENDYOL_SYNC_SHIPMENT_PACKAGES"] },
        status: { in: ["queued", "running", "retrying"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, createdAt: true },
    });

    return res.status(409).json({
      error: "sync_in_progress",
      connectionId: id,
      jobId: active?.id,
      status: active?.status,
      createdAt: active?.createdAt,
      deprecated: true,
      note: "Use /v1/connections/:id/sync/orders",
    });
  }

  let jobRow: { id: string } | null = null;
  try {
    jobRow = await prisma.job.create({
      data: {
        connectionId: id,
        type: "TRENDYOL_SYNC_SHIPMENT_PACKAGES",
        status: "queued",
      },
      select: { id: true },
    });

    await redis.set(lockKey, jobRow.id, "PX", SYNC_LOCK_TTL_MS);

    await eciQueue.add(
      "TRENDYOL_SYNC_SHIPMENT_PACKAGES",
      { jobId: jobRow.id, connectionId: id, params: body ?? null },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      }
    );

    return res.json({ jobId: jobRow.id, deprecated: true, note: "Use /v1/connections/:id/sync/orders" });
  } catch (e: any) {
    await redis.del(lockKey);
    if (jobRow?.id) {
      await prisma.job.update({
        where: { id: jobRow.id },
        data: { status: "failed", finishedAt: new Date(), error: String(e?.message ?? e) },
      });
    }
    throw e;
  }
}));


app.get("/v1/jobs", asyncHandler(async (req: Request, res: Response) => {
  const connectionId = String(req.query.connectionId ?? "");
  const rows = await prisma.job.findMany({
    where: connectionId ? { connectionId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(rows);
}));

app.get("/v1/jobs/recent", asyncHandler(async (req: Request, res: Response) => {
  const connectionId = String(req.query.connectionId ?? "");
  const limit = req.query.limit ? Math.max(1, Math.min(200, Number(req.query.limit))) : 50;

  const rows = await prisma.job.findMany({
    where: connectionId ? { connectionId } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json(rows);
}));

app.get("/v1/orders", asyncHandler(async (req: Request, res: Response) => {
  const connectionId = String(req.query.connectionId ?? "");
  const rows = await prisma.order.findMany({
    where: connectionId ? { connectionId } : undefined,
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  res.json(rows);
}));

app.get("/v1/shipment-packages", asyncHandler(async (req: Request, res: Response) => {
  const connectionId = String(req.query.connectionId ?? "");
  const rows = await prisma.shipmentPackage.findMany({
    where: connectionId ? { connectionId } : undefined,
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  res.json(rows);
}));

// -----------------------------
// Error handling
// -----------------------------
app.use((_req: Request, res: Response) => res.status(404).json({ error: "not_found" }));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[eci-api] route_error", err);
  res.status(500).json({ error: "internal_error", message: String(err?.message ?? err) });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;

app.listen(port, "0.0.0.0", () => {
  console.log(`[eci-api] pid=${process.pid} listening on http://127.0.0.1:${port}`);
});