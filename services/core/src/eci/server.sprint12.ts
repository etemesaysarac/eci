/*
Sprint 12 — Claims / İade
========================

Scope (STEP-3A):
  - Enqueue a single SYNC job that pulls claims from Trendyol (GET getClaims)
  - Persist Claim + ClaimItem rows via worker

Endpoints (this file):
  - POST /v1/connections/:id/sync/claims

Notes:
  - Uses the same per-connection sync lock (eci:sync:lock:<connectionId>)
  - This is intentionally small: approve/reject/audits/read endpoints will come next.
*/

import type { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import IORedis from "ioredis";
import { randomUUID } from "crypto";
import { z } from "zod";

import { eciQueue } from "./queue";
import { prisma } from "./prisma";
import { loadTrendyolConfig } from "./connections";
import { trendyolGetClaimsIssueReasons } from "./connectors/trendyol/client";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const SYNC_LOCK_TTL_MS = Number(process.env.SYNC_LOCK_TTL_MS ?? 60 * 60 * 1000);
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

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
    res.status(400).json({
      error: {
        formErrors: [],
        fieldErrors: { connectionId: ["Missing connectionId (query or x-eci-connectionid header)"] },
      },
    });
    return null;
  }
  return connectionId;
}

function syncLockKey(connectionId: string) {
  return `eci:sync:lock:${connectionId}`;
}

const SyncClaimsSchema = z
  .object({
    // claimItemStatus on Trendyol side (optional)
    status: z.string().optional(),
    startDate: z.number().int().optional(),
    endDate: z.number().int().optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .optional();

const ReadClaimsQuerySchema = z
  .object({
    connectionId: z.string().min(1),
    status: z.string().optional(),
    page: z.coerce.number().int().min(0).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();


const ApproveClaimItemsBodySchema = z
  .object({
    // Trendyol naming
    claimLineItemIdList: z.array(z.string().min(1)).optional(),
    // Aliases (some callers say claimItemIdList)
    claimItemIdList: z.array(z.string().min(1)).optional(),
    // Optional extra params (ignored by backend; accepted to avoid client errors)
    params: z.any().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
  .optional();


const RejectClaimIssueBodySchema = z
  .object({
    // Trendyol naming
    claimLineItemIdList: z.array(z.string().min(1)).optional(),
    // Alias
    claimItemIdList: z.array(z.string().min(1)).optional(),
    claimIssueReasonId: z.union([z.number(), z.string()]),
    description: z.string().min(1).max(500),
    fileName: z.string().optional(),
    fileBase64: z.string().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const list = val.claimLineItemIdList ?? val.claimItemIdList;
    if (!list || list.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "claimLineItemIdList (or claimItemIdList) is required",
        path: ["claimLineItemIdList"],
      });
    }
  });


function isMockClaimId(id: string) {
  return String(id ?? "").startsWith("MOCK-");
}



// list claim items for UI (optional filters + pagination)
const ReadClaimItemsQuerySchema = z
  .object({
    connectionId: z.string().min(1),
    claimId: z.string().optional(),
    itemStatus: z.string().optional(),
    page: z.coerce.number().int().min(0).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

// lightweight stats for dashboard / quick sanity checks
const ReadClaimStatsQuerySchema = z
  .object({
    connectionId: z.string().min(1),
  })
  .strict();

// DEV: seed mock claims into DB when seller test account has no real returns.
// This is *local-only* data; do NOT use as Trendyol integration proof.
const SeedClaimsSchema = z
  .object({
    claims: z.number().int().min(1).max(20).optional(),
    itemsPerClaim: z.number().int().min(1).max(10).optional(),
    includeAudits: z.boolean().optional(),
  })
  .strict()
  .optional();


export function registerSprint12ClaimRoutes(app: any) {
/**
 * DEV ONLY: Seed mock claims into DB (for UI testing when no real claims exist).
 * POST /v1/connections/:id/dev/seed-claims
 * Body (optional): { claims?: number; itemsPerClaim?: number; includeAudits?: boolean }
 */
app.post(
  "/v1/connections/:id/dev/seed-claims",
  asyncHandler(async (req: Request, res: Response) => {
    // Safety: never allow in production
    if (process.env.NODE_ENV === "production") return res.status(404).json({ error: "not_found" });

    const id = String(req.params.id ?? "");
    const conn = await prisma.connection.findUnique({
      where: { id },
      select: { id: true, type: true },
    });
    if (!conn) return res.status(404).json({ error: "not_found" });
    if (conn.type !== "trendyol") return res.status(400).json({ error: "only trendyol supported for now" });

    const parsed = SeedClaimsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const body = parsed.data ?? {};
    const claims = body.claims ?? 1;
    const itemsPerClaim = body.itemsPerClaim ?? 2;
    const includeAudits = body.includeAudits ?? true;

    const now = new Date();
    const seeded: Array<{ claimId: string; items: Array<{ claimItemId: string; itemStatus: string | null }> }> = [];

    await prisma.$transaction(async (tx) => {
      for (let ci = 0; ci < claims; ci++) {
        const claimId = `MOCK-CL-${now.getTime()}-${randomUUID().slice(0, 8)}-${ci + 1}`;

        const claim = await tx.claim.create({
          data: {
            connectionId: id,
            marketplace: "trendyol",
            claimId,
            status: "WaitingInAction",
            orderNumber: `MOCK-ORDER-${ci + 1}`,
            claimDate: now,
            lastModifiedAt: now,
            raw: { mock: true, seededAt: now.toISOString(), note: "Seeded for local testing only" },
          },
          select: { id: true, claimId: true },
        });

        const claimSeed = { claimId: claim.claimId, items: [] as Array<{ claimItemId: string; itemStatus: string | null }> };

        for (let ii = 0; ii < itemsPerClaim; ii++) {
          const claimItemId = `MOCK-CI-${randomUUID().slice(0, 12)}-${ii + 1}`;

          // first item is actionable; others are just "Created"
          const itemStatus = ii === 0 ? "WaitingInAction" : "Created";

          const item = await tx.claimItem.create({
            data: {
              connectionId: id,
              marketplace: "trendyol",
              claimDbId: claim.id,
              claimId: claim.claimId,
              claimItemId,
              barcode: `MOCK-BARCODE-${ii + 1}`,
              sku: `MOCK-SKU-${ii + 1}`,
              quantity: 1,
              itemStatus,
              reasonCode: "MOCK",
              reasonName: "Mock seeded reason",
              raw: { mock: true, seededAt: now.toISOString() },
            },
            select: { id: true, claimItemId: true, itemStatus: true },
          });

          claimSeed.items.push({ claimItemId: item.claimItemId, itemStatus: item.itemStatus });

          if (includeAudits) {
            const base = now.getTime() + ci * 1000 + ii * 100;

            // Seed audit: Created
            await tx.claimAudit.create({
              data: {
                connectionId: id,
                marketplace: "trendyol",
                claimItemDbId: item.id,
                previousStatus: null,
                newStatus: "Created",
                executorApp: "MockSellerIntegrationApi",
                executorUser: "mock",
                date: new Date(base + 1),
                raw: { mock: true, note: "Seed audit (local only)" },
              },
            });

            // Seed audit: current status (only if different)
            if (itemStatus !== "Created") {
              await tx.claimAudit.create({
                data: {
                  connectionId: id,
                  marketplace: "trendyol",
                  claimItemDbId: item.id,
                  previousStatus: "Created",
                  newStatus: itemStatus,
                  executorApp: "MockSellerIntegrationApi",
                  executorUser: "mock",
                  date: new Date(base + 2),
                  raw: { mock: true, note: "Seed audit (local only)" },
                },
              });
            }
          }
        }

        seeded.push(claimSeed);
      }
    });

    return res.json({ connectionId: id, seededClaims: seeded.length, seeded });
  })
);

  /**
   * POST /v1/connections/:id/sync/claims
   * Body (optional): { status?, startDate?, endDate?, pageSize? }
   */
  app.post(
    "/v1/connections/:id/sync/claims",
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "");

      const conn = await prisma.connection.findUnique({
        where: { id },
        select: { id: true, type: true },
      });
      if (!conn) return res.status(404).json({ error: "not_found" });
      if (conn.type !== "trendyol") return res.status(400).json({ error: "only trendyol supported for now" });

      const parsed = SyncClaimsSchema?.safeParse(req.body);
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
            type: { in: ["TRENDYOL_SYNC_ORDERS", "TRENDYOL_SYNC_CLAIMS"] },
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
            type: "TRENDYOL_SYNC_CLAIMS",
            status: "queued",
          },
          select: { id: true },
        });

        // lock owner'ı gerçek jobId yapalım (worker release edebilsin)
        await redis.set(lockKey, jobRow.id, "PX", SYNC_LOCK_TTL_MS);

        await eciQueue.add(
          "TRENDYOL_SYNC_CLAIMS",
          { jobId: jobRow.id, connectionId: id, params: body ?? null },
          {
            // Stabilizasyon: bir hata oldu diye direkt "failed" olmasın.
            attempts: 5,
            backoff: { type: "exponential", delay: 1000 },
            removeOnComplete: 1000,
            removeOnFail: 1000,
          }
        );

        return res.json({ jobId: jobRow.id });
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
    })
  );

  /**
   * Read list (panel)
   * GET /v1/claims?connectionId=...&status=...&page=0&pageSize=50
   */
  app.get(
    "/v1/claims",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = ReadClaimsQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const { connectionId, status } = parsed.data;
      const page = parsed.data.page ?? 0;
      const pageSize = parsed.data.pageSize ?? 50;

      const rows = await prisma.claim.findMany({
        where: {
          connectionId,
          marketplace: "trendyol",
          ...(status ? { status } : {}),
        },
        orderBy: [{ lastModifiedAt: "desc" }, { updatedAt: "desc" }],
        skip: page * pageSize,
        take: pageSize,
        select: {
          id: true,
          claimId: true,
          status: true,
          orderNumber: true,
          claimDate: true,
          lastModifiedAt: true,
          updatedAt: true,
          _count: { select: { items: true } },
        },
      });

      return res.json({
        page,
        pageSize,
        items: rows.map((r) => ({
          id: r.id,
          claimId: r.claimId,
          status: r.status,
          orderNumber: r.orderNumber,
          claimDate: r.claimDate,
          lastModifiedAt: r.lastModifiedAt,
          updatedAt: r.updatedAt,
          itemCount: r._count.items,
        })),
      });
    })
  );

  
  /**
   * Read stats (panel)
   * GET /v1/claims/stats?connectionId=...
   */
  app.get(
    "/v1/claims/stats",
    asyncHandler(async (req, res) => {
      const parsed = ReadClaimStatsQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });

      const { connectionId } = parsed.data;

      const [claimTotal, claimGroups, itemTotal, itemGroups] = await Promise.all([
        prisma.claim.count({ where: { connectionId, marketplace: "trendyol" } }),
        prisma.claim.groupBy({
          by: ["status"],
          where: { connectionId, marketplace: "trendyol" },
          _count: { _all: true },
        }),
        prisma.claimItem.count({ where: { connectionId, marketplace: "trendyol" } }),
        prisma.claimItem.groupBy({
          by: ["itemStatus"],
          where: { connectionId, marketplace: "trendyol" },
          _count: { _all: true },
        }),
      ]);

      const claimsByStatus: Record<string, number> = {};
      for (const g of claimGroups) {
        const key = String((g as any).status ?? "UNKNOWN");
        claimsByStatus[key] = (g as any)._count?._all ?? 0;
      }

      const itemsByStatus: Record<string, number> = {};
      for (const g of itemGroups) {
        const key = String((g as any).itemStatus ?? "UNKNOWN");
        itemsByStatus[key] = (g as any)._count?._all ?? 0;
      }

      return res.json({
        connectionId,
        claims: { total: claimTotal, byStatus: claimsByStatus },
        items: { total: itemTotal, byStatus: itemsByStatus },
        updatedAt: new Date().toISOString(),
      });
    })
  );

  
  /**
   * DEV helper: DB counts (used by proof script, avoids docker/psql quoting issues)
   * GET /v1/claims/dev/counts?connectionId=...
   */
  app.get(
    "/v1/claims/dev/counts",
    asyncHandler(async (req: Request, res: Response) => {
      const connectionId = requireConnectionId(req, res);
      if (!connectionId) return;

      const [claimCount, claimItemCount, claimAuditCount, claimCommandCount] = await Promise.all([
        prisma.claim.count({ where: { connectionId, marketplace: "trendyol" } }),
        prisma.claimItem.count({ where: { connectionId, marketplace: "trendyol" } }),
        prisma.claimAudit.count({ where: { connectionId, marketplace: "trendyol" } }),
        prisma.claimCommand.count({ where: { connectionId, marketplace: "trendyol" } }),
      ]);

      return res.json({
        connectionId,
        claimCount,
        claimItemCount,
        claimAuditCount,
        claimCommandCount,
      });
    })
  );

/**
   * Read claim items (panel)
   * GET /v1/claims/items?connectionId=...&claimId=...&itemStatus=...&page=0&pageSize=50
   */
  app.get(
    "/v1/claims/items",
    asyncHandler(async (req, res) => {
      const parsed = ReadClaimItemsQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });

      const { connectionId, claimId, itemStatus } = parsed.data;
      const page = parsed.data.page ?? 0;
      const pageSize = parsed.data.pageSize ?? 50;

      const where: any = { connectionId, marketplace: "trendyol" };
      if (claimId) where.claimId = claimId;
      if (itemStatus) where.itemStatus = itemStatus;

      const [total, items] = await Promise.all([
        prisma.claimItem.count({ where }),
        prisma.claimItem.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip: page * pageSize,
          take: pageSize,
          select: {
            claimId: true,
            claimItemId: true,
            sku: true,
            barcode: true,
            quantity: true,
            itemStatus: true,
            reasonCode: true,
            reasonName: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      ]);

      return res.json({ page, pageSize, total, items });
    })
  );
/**
   * Read detail (panel)
   * GET /v1/claims/:claimId?connectionId=...
   */
  app.get(
    "/v1/claims/:claimId",
    asyncHandler(async (req: Request, res: Response) => {
      const claimId = String(req.params.claimId ?? "");
      const connectionId = requireConnectionId(req, res);
      if (!connectionId) return;
      if (claimId === "issue-reasons") {
        try {
          const cfg = await loadTrendyolConfig(req);
          const reasons = await trendyolGetClaimsIssueReasons(cfg);
          return res.json({ source: "trendyol", reasons });
        } catch (e: any) {
          // DEV fallback: static list for local UI wiring
          return res.json({
            source: "mock",
            reasons: [
              { id: 1651, name: "1651 (Mock) - file not required" },
              { id: 451, name: "451 (Mock) - file not required" },
              { id: 2101, name: "2101 (Mock) - file not required" },
            ],
            note: "Trendyol call failed; returned a minimal mock dictionary for local development.",
            error: String(e?.message ?? e),
          });
        }
      }
      const detailSelect = {
        id: true,
        claimId: true,
        status: true,
        orderNumber: true,
        claimDate: true,
        lastModifiedAt: true,
        raw: true,
        items: {
          orderBy: [{ updatedAt: "desc" }],
          select: {
            id: true,
            claimItemId: true,
            claimId: true,
            barcode: true,
            sku: true,
            quantity: true,
            itemStatus: true,
            reasonCode: true,
            reasonName: true,
            updatedAt: true,
          },
        },
      } as const;

      let row = await prisma.claim.findFirst({
        where: { connectionId, marketplace: "trendyol", OR: [{ claimId }, { id: claimId }] },
        select: detailSelect,
      });

      // Fallback: callers sometimes pass a claimId/claimItemId that exists only on ClaimItem rows.
      // Derive the parent claim via claimDbId in that case.
      if (!row) {
        const hint = await prisma.claimItem.findFirst({
          where: {
            connectionId,
            marketplace: "trendyol",
            OR: [{ claimId }, { claimItemId: claimId }],
          },
          select: { claimDbId: true },
        });

        if (hint?.claimDbId) {
          row = await prisma.claim.findFirst({
            where: { connectionId, marketplace: "trendyol", id: hint.claimDbId },
            select: detailSelect,
          });
        }
      }

      if (!row) return res.status(404).json({ error: "not_found" });
      return res.json(row);
    })
  );

  /**
   * Read audits for a claimItemId (remote id)
   * GET /v1/claims/items/:claimItemId/audits?connectionId=...
   */
  app.get(
    "/v1/claims/items/:claimItemId/audits",
    asyncHandler(async (req: Request, res: Response) => {
      const claimItemId = String(req.params.claimItemId ?? "");
      const connectionId = requireConnectionId(req, res);
      if (!connectionId) return;

      const item = await prisma.claimItem.findFirst({
        where: { connectionId, marketplace: "trendyol", claimItemId },
        select: { id: true },
      });
      if (!item) return res.status(404).json({ error: "not_found" });

      const audits = await prisma.claimAudit.findMany({
        where: { connectionId, marketplace: "trendyol", claimItemDbId: item.id },
        orderBy: [{ date: "asc" }],
        select: {
          previousStatus: true,
          newStatus: true,
          executorApp: true,
          executorUser: true,
          date: true,
          raw: true,
        },
      });

      return res.json({ claimItemId, audits });
    })
  );



/**
 * Approve (command)
 * POST /v1/claims/:claimId/approve?connectionId=...
 * Body: { claimLineItemIdList?: string[], dryRun?: boolean }
 */
app.post(
  "/v1/claims/:claimId/approve",
  asyncHandler(async (req: Request, res: Response) => {
    const claimId = String(req.params.claimId ?? "");
    const connectionId = requireConnectionId(req, res);
    if (!connectionId) return;

    const parsedB = ApproveClaimItemsBodySchema.safeParse(req.body);
    if (!parsedB.success) return res.status(400).json({ error: parsedB.error.flatten() });
    const body: any = parsedB.data ?? {};
    const requestedIds: string[] | null = body.claimLineItemIdList ?? body.claimItemIdList ?? null;
    const dryRun = !!body.dryRun;

    // DEV: inline simulation for MOCK-* claims (no worker/redis required)
    if (isMockClaimId(claimId)) {
      const result = await prisma.$transaction(async (tx) => {
        const claim = await tx.claim.findFirst({
          where: { connectionId, marketplace: "trendyol", OR: [{ claimId }, { id: claimId }] },
          select: { id: true, status: true },
        });
        if (!claim) return null;

        const items = await tx.claimItem.findMany({
          where: { connectionId, marketplace: "trendyol", claimDbId: claim.id },
          select: { id: true, claimItemId: true, itemStatus: true },
        });

        const targetSet = new Set(((requestedIds ?? items.map((i) => i.claimItemId)) as string[]).map(String));
        const actionable = items.filter((i) => i.itemStatus === "WaitingInAction" && targetSet.has(i.claimItemId));

        if (dryRun) {
          return { mode: "mock-dry", claimId, connectionId, actionableCount: actionable.length, claimStatus: claim.status };
        }

        const now = new Date();

        // update item statuses
        for (const it of actionable) {
          await tx.claimItem.update({
            where: { id: it.id },
            data: { itemStatus: "WaitingFraudCheck", updatedAt: now },
          });

          await tx.claimAudit.create({
            data: {
              connectionId,
              marketplace: "trendyol",
              claimItemDbId: it.id,
              previousStatus: it.itemStatus,
              newStatus: "WaitingFraudCheck",
              executorApp: "MockEci",
              executorUser: "eci-dev",
              date: now,
              raw: { mock: true, note: "Local approve simulation (no Trendyol call)" },
            },
          });
        }

        await tx.claim.update({
          where: { id: claim.id },
          data: { status: "WaitingFraudCheck", lastModifiedAt: now, updatedAt: now },
        });

        const cmd = await tx.claimCommand.create({
          data: {
            connectionId,
            marketplace: "trendyol",
            claimId,

            commandType: "approve",
            status: "succeeded",
            request: { claimId, claimLineItemIdList: actionable.map((x) => x.claimItemId), dryRun: false, mock: true },
            response: { ok: true, simulated: true, movedTo: "WaitingFraudCheck", affected: actionable.length },
},
          select: { id: true },
        });

        return { mode: "mock", claimId, connectionId, affected: actionable.length, claimCommandId: cmd.id };
      });

      if (!result) return res.status(404).json({ error: "not_found" });
      return res.json(result);
    }

    // REAL: enqueue worker command
    const cmd = await prisma.claimCommand.create({
      data: {
        connectionId,
        marketplace: "trendyol",
        claimId,

        commandType: "approve",
        status: "queued",
        request: { claimId, claimLineItemIdList: requestedIds ?? null, dryRun },
      },
      select: { id: true },
    });

    const jobRow = await prisma.job.create({
      data: {
        connectionId,
        type: "TRENDYOL_CLAIM_APPROVE",
        status: "queued",
        payload: { claimId, claimLineItemIdList: requestedIds ?? null, claimCommandId: cmd.id, dryRun },
      },
      select: { id: true },
    });

    await eciQueue.add(
      "TRENDYOL_CLAIM_APPROVE",
      { jobId: jobRow.id, connectionId, params: { claimId, claimLineItemIdList: requestedIds ?? null, claimCommandId: cmd.id, dryRun } },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 }
    );

    return res.json({ mode: "queued", jobId: jobRow.id, claimCommandId: cmd.id });
  })
);

/**
 * Reject via "createClaimIssue" (command)
 * POST /v1/claims/:claimId/reject?connectionId=...
 * Body: { claimLineItemIdList: string[], claimIssueReasonId, description, fileName?, fileBase64?, dryRun? }
 */
app.post(
  "/v1/claims/:claimId/reject",
  asyncHandler(async (req: Request, res: Response) => {
    const claimId = String(req.params.claimId ?? "");
    const connectionId = requireConnectionId(req, res);
    if (!connectionId) return;

    const parsedB = RejectClaimIssueBodySchema.safeParse(req.body);
    if (!parsedB.success) return res.status(400).json({ error: parsedB.error.flatten() });
    const body: any = parsedB.data;
    const dryRun = !!body.dryRun;
    const requestedIds: string[] = body.claimLineItemIdList ?? body.claimItemIdList;

    // DEV: inline simulation for MOCK-* claims
    if (isMockClaimId(claimId)) {
      const result = await prisma.$transaction(async (tx) => {
        const claim = await tx.claim.findFirst({
          where: { connectionId, marketplace: "trendyol", OR: [{ claimId }, { id: claimId }] },
          select: { id: true, status: true },
        });
        if (!claim) return null;

        const items = await tx.claimItem.findMany({
          where: { connectionId, marketplace: "trendyol", claimDbId: claim.id },
          select: { id: true, claimItemId: true, itemStatus: true },
        });

        const targetSet = new Set(requestedIds.map(String));
        const actionable = items.filter((i) => i.itemStatus === "WaitingInAction" && targetSet.has(i.claimItemId));

        if (dryRun) {
          return { mode: "mock-dry", claimId, connectionId, actionableCount: actionable.length, claimStatus: claim.status };
        }

        const now = new Date();
        for (const it of actionable) {
          await tx.claimItem.update({ where: { id: it.id }, data: { itemStatus: "IssueCreated", updatedAt: now } });
          await tx.claimAudit.create({
            data: {
              connectionId,
              marketplace: "trendyol",
              claimItemDbId: it.id,
              previousStatus: it.itemStatus,
              newStatus: "IssueCreated",
              executorApp: "MockEci",
              executorUser: "eci-dev",
              date: now,
              raw: { mock: true, note: "Local reject simulation (no Trendyol call)", claimIssueReasonId: body.claimIssueReasonId },
            },
          });
        }

        const cmd = await tx.claimCommand.create({
          data: {
            connectionId,
            marketplace: "trendyol",
            claimId,

            commandType: "rejectIssue",
            status: "succeeded",
            request: { claimId, claimLineItemIdList: actionable.map((x) => x.claimItemId), claimIssueReasonId: body.claimIssueReasonId, description: body.description, mock: true },
            response: { ok: true, simulated: true, movedTo: "IssueCreated", affected: actionable.length },
},
          select: { id: true },
        });

        return { mode: "mock", claimId, connectionId, affected: actionable.length, claimCommandId: cmd.id };
      });

      if (!result) return res.status(404).json({ error: "not_found" });
      return res.json(result);
    }

    const cmd = await prisma.claimCommand.create({
      data: {
        connectionId,
        marketplace: "trendyol",
        claimId,

        commandType: "rejectIssue",
        status: "queued",
        request: {
          claimId,
          claimLineItemIdList: requestedIds,
          claimIssueReasonId: body.claimIssueReasonId,
          description: body.description,
          fileName: body.fileName ?? null,
          hasFile: !!body.fileBase64,
          dryRun,
        },
      },
      select: { id: true },
    });

    const jobRow = await prisma.job.create({
      data: {
        connectionId,
        type: "TRENDYOL_CLAIM_REJECT_ISSUE",
        status: "queued",
        payload: {
          claimId,
          claimLineItemIdList: requestedIds,
          claimIssueReasonId: body.claimIssueReasonId,
          description: body.description,
          fileName: body.fileName ?? null,
          fileBase64: body.fileBase64 ?? null,
          claimCommandId: cmd.id,
          dryRun,
        },
      },
      select: { id: true },
    });

    await eciQueue.add(
      "TRENDYOL_CLAIM_REJECT_ISSUE",
      {
        jobId: jobRow.id,
        connectionId,
        params: {
          claimId,
          claimLineItemIdList: requestedIds,
          claimIssueReasonId: body.claimIssueReasonId,
          description: body.description,
          fileName: body.fileName ?? null,
          fileBase64: body.fileBase64 ?? null,
          claimCommandId: cmd.id,
          dryRun,
        },
      },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 }
    );

    return res.json({ mode: "queued", jobId: jobRow.id, claimCommandId: cmd.id });
  })
);

}
