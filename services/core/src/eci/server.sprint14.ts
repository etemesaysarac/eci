/*
Sprint 14 — Finance (Trendyol)
=============================

Scope (core):
  - Sync finance data from Trendyol Finance (CHE) endpoints into DB
  - Read endpoints for panel/proof queries

Endpoints (this file):
  - POST /v1/connections/:id/sync/finance
  - GET  /v1/finance/settlements?connectionId=...&transactionType=...&from=...&to=...&page=0&pageSize=50
  - GET  /v1/finance/otherfinancials?connectionId=...&transactionType=...&from=...&to=...&page=0&pageSize=50
  - GET  /v1/finance/cargo-invoice-items?connectionId=...&invoiceSerialNumber=...&invoiceNumber=...&page=0&pageSize=50

Notes:
  - Finance endpoints require startDate/endDate and a single transactionType per request.
  - Max window is 15 days (enforced in worker + validated at API boundary).
  - We reuse the existing per-connection sync lock key to avoid concurrency surprises.
*/

import type { Express, Request, Response, NextFunction } from "express";
import asyncHandler from "express-async-handler";
import IORedis from "ioredis";
import { randomUUID } from "crypto";
import { z } from "zod";

import { eciQueue } from "./queue";
import { prisma } from "./prisma";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const SYNC_LOCK_TTL_MS = Number(process.env.SYNC_LOCK_TTL_MS ?? 60 * 60 * 1000);
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

function syncLockKey(connectionId: string) {
  return `eci:sync:lock:${connectionId}`;
}

function clampInt(v: any, fallback: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.min(max, Math.max(min, i));
}

function getConnectionIdFromReq(req: Request): string {
  const q: any = (req as any).query ?? {};
  const h: any = (req as any).headers ?? {};
  return String(
    q.connectionId ??
      q.connectionid ??
      h["x-eci-connectionid"] ??
      h["x-eci-connection-id"] ??
      ""
  );
}

function requireConnectionId(req: Request, res: Response): string | null {
  const connectionId = getConnectionIdFromReq(req);
  if (!connectionId) {
    res.status(400).json({ error: "connectionId_required" });
    return null;
  }
  return connectionId;
}

const SyncFinanceSchema = z
  .object({
    // epoch-ms; if omitted, worker will use a safe default windowDays back from now
    startDate: z.number().int().optional(),
    endDate: z.number().int().optional(),

    // finance rule: max 15 days per request; worker will slice windows accordingly
    windowDays: z.number().int().min(1).max(15).optional(),
    lookbackWindows: z.number().int().min(1).max(24).optional(),

    // Trendyol finance accepts only 500 or 1000 (observed via probe)
    size: z.union([z.literal(500), z.literal(1000)]).optional(),

    // optional override lists (otherwise worker defaults will be used)
    settlementTypes: z.array(z.string()).optional(),
    otherFinancialTypes: z.array(z.string()).optional(),
  })
  .optional();

export function registerSprint14FinanceRoutes(app: Express) {
  // Express 4 does NOT automatically catch async errors.
  const asyncWrap =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<any> | any) =>
    (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve(fn(req, res, next)).catch(next);

  /**
   * POST /v1/connections/:id/sync/finance
   * Body (optional): { startDate?, endDate?, windowDays?, lookbackWindows?, size?, settlementTypes?, otherFinancialTypes? }
   */
  app.post(
    "/v1/connections/:id/sync/finance",
    asyncWrap(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "");

      const conn = await prisma.connection.findUnique({
        where: { id },
        select: { id: true, type: true },
      });
      if (!conn) return res.status(404).json({ error: "not_found" });
      if (conn.type !== "trendyol") return res.status(400).json({ error: "only trendyol supported for now" });

      const parsed = SyncFinanceSchema?.safeParse(req.body);
      if (parsed && !parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const body = parsed?.success ? parsed.data ?? undefined : undefined;

      // Concurrency guard: connection bazlı tek aktif sync
      const lockKey = syncLockKey(id);
      const pending = `pending:${randomUUID()}`;
      const acquired = await redis.set(lockKey, pending, "PX", SYNC_LOCK_TTL_MS, "NX");

      if (acquired !== "OK") {
        const active = await prisma.job.findFirst({
          where: {
            connectionId: id,
            type: { in: ["TRENDYOL_SYNC_ORDERS", "TRENDYOL_SYNC_CLAIMS", "TRENDYOL_SYNC_QNA_QUESTIONS", "TRENDYOL_SYNC_FINANCE"] },
            status: { in: ["queued", "running", "retrying"] },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true, createdAt: true, type: true },
        });

        return res.status(409).json({
          error: "sync_in_progress",
          connectionId: id,
          jobId: active?.id,
          status: active?.status,
          type: active?.type,
          createdAt: active?.createdAt,
        });
      }

      let jobRow: { id: string } | null = null;
      try {
        jobRow = await prisma.job.create({
          data: {
            connectionId: id,
            type: "TRENDYOL_SYNC_FINANCE",
            status: "queued",
          },
          select: { id: true },
        });

        // lock owner'ı gerçek jobId yapalım (worker release edebilsin)
        await redis.set(lockKey, jobRow.id, "PX", SYNC_LOCK_TTL_MS);

        await eciQueue.add(
          "TRENDYOL_SYNC_FINANCE",
          { jobId: jobRow.id, connectionId: id, params: body ?? null },
          {
            attempts: 5,
            backoff: { type: "exponential", delay: 1000 },
            removeOnComplete: 1000,
            removeOnFail: 1000,
          }
        );

        return res.json({ jobId: jobRow.id });
      } catch (e: any) {
        // best-effort: unlock on route failure
        try {
          await redis.del(lockKey);
        } catch {}
        if (jobRow?.id) {
          await prisma.job.update({
            where: { id: jobRow.id },
            data: { status: "failed", finishedAt: new Date(), error: String(e?.message ?? e) },
          });
        }
        throw e;
      }
    })
  );

  /**
   * GET /v1/finance/settlements
   */
  app.get(
    "/v1/finance/settlements",
    asyncHandler(async (req: Request, res: Response) => {
      const connectionId = requireConnectionId(req, res);
      if (!connectionId) return;

      const transactionType = String((req.query.transactionType ?? "")).trim();
      const from = Number(req.query.from ?? "");
      const to = Number(req.query.to ?? "");
      const page = clampInt(req.query.page, 0, 0, 999999);
      const pageSize = clampInt(req.query.pageSize, 50, 1, 200);

      const where: any = { connectionId };
      if (transactionType) where.transactionType = transactionType;
      if (Number.isFinite(from) || Number.isFinite(to)) {
        where.updatedAt = {};
        if (Number.isFinite(from)) where.updatedAt.gte = new Date(from);
        if (Number.isFinite(to)) where.updatedAt.lte = new Date(to);
      }

      const [rows, total] = await Promise.all([
        prisma.settlement.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip: page * pageSize,
          take: pageSize,
        }),
        prisma.settlement.count({ where }),
      ]);

      res.json({ page, pageSize, total, rows });
    })
  );

  /**
   * GET /v1/finance/otherfinancials
   */
  app.get(
    "/v1/finance/otherfinancials",
    asyncHandler(async (req: Request, res: Response) => {
      const connectionId = requireConnectionId(req, res);
      if (!connectionId) return;

      const transactionType = String((req.query.transactionType ?? "")).trim();
      const from = Number(req.query.from ?? "");
      const to = Number(req.query.to ?? "");
      const page = clampInt(req.query.page, 0, 0, 999999);
      const pageSize = clampInt(req.query.pageSize, 50, 1, 200);

      const where: any = { connectionId };
      if (transactionType) where.transactionType = transactionType;
      if (Number.isFinite(from) || Number.isFinite(to)) {
        where.updatedAt = {};
        if (Number.isFinite(from)) where.updatedAt.gte = new Date(from);
        if (Number.isFinite(to)) where.updatedAt.lte = new Date(to);
      }

      const [rows, total] = await Promise.all([
        prisma.financialTxn.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip: page * pageSize,
          take: pageSize,
        }),
        prisma.financialTxn.count({ where }),
      ]);

      res.json({ page, pageSize, total, rows });
    })
  );

  /**
   * GET /v1/finance/cargo-invoice-items
   */
  app.get(
    "/v1/finance/cargo-invoice-items",
    asyncHandler(async (req: Request, res: Response) => {
      const connectionId = requireConnectionId(req, res);
      if (!connectionId) return;

      const invoiceSerialNumber = String((req.query.invoiceSerialNumber ?? "")).trim();
      const invoiceNumber = String((req.query.invoiceNumber ?? "")).trim();
      const page = clampInt(req.query.page, 0, 0, 999999);
      const pageSize = clampInt(req.query.pageSize, 50, 1, 200);

      const where: any = { connectionId };
      if (invoiceSerialNumber) where.invoiceSerialNumber = invoiceSerialNumber;
      if (invoiceNumber) where.invoiceNumber = invoiceNumber;

      const [rows, total] = await Promise.all([
        prisma.cargoInvoiceItem.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip: page * pageSize,
          take: pageSize,
        }),
        prisma.cargoInvoiceItem.count({ where }),
      ]);

      res.json({ page, pageSize, total, rows });
    })
  );
}
