/*
Sprint 13 — QnA (Questions & Answers)
====================================

Scope (Step 5.1 - Read path, minimal):
  - GET /v1/qna/questions?connectionId=...&status=...&page=0&pageSize=50&from=...&to=...
  - Alias (master-context): GET /eci/sprint13/qna/questions?connectionId=...&status=...&page=0&size=20
  - Reads from DB (Question table) only.

Notes:
  - connectionId is required (multi-tenant safety)
  - pageSize is clamped to max 50
  - from/to are optional epoch-ms filters applied to askedAt
*/

import type { Request, Response } from "express";
import type express from "express";
import asyncHandler from "express-async-handler";
import crypto from "crypto";
import { z } from "zod";

import { eciQueue } from "./queue";
import { prisma } from "./prisma";

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

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

const ListSchema = z.object({
  // connectionId is validated separately via requireConnectionId for flexibility.
  connectionId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  page: z.coerce.number().int().min(0).default(0),
  // "pageSize" is canonical, "size" is supported for master-context compatibility.
  pageSize: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).optional(),
  from: z.coerce.number().int().optional(), // epoch ms
  to: z.coerce.number().int().optional(),   // epoch ms
});

function resolvePageSize(input: { pageSize?: number; size?: number }) {
  return clamp(input.pageSize ?? input.size ?? 50, 1, 50);
}

const AnswerBodySchema = z.object({
  text: z.string().trim().min(10).max(2000),
  dryRun: z.boolean().optional(),
  executorApp: z.string().trim().min(1).optional(),
  executorUser: z.string().trim().min(1).optional(),
});

export function registerSprint13QnaRoutes(app: express.Express) {
  const listHandler: express.RequestHandler = async (req, res) => {
    const connectionId = requireConnectionId(req as any, res as any);
    if (!connectionId) return;

    const parsed = ListSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "bad_request", issues: parsed.error.issues });

    const { status, page, from, to } = parsed.data;
    const pageSize = resolvePageSize(parsed.data);

    const where: any = { connectionId };
    if (status) where.status = status;
    if (from || to) {
      where.askedAt = {};
      if (from) where.askedAt.gte = new Date(from);
      if (to) where.askedAt.lte = new Date(to);
    }

    const [total, items] = await Promise.all([
      prisma.question.count({ where }),
      prisma.question.findMany({
        where,
        orderBy: [{ askedAt: "desc" }, { lastModifiedAt: "desc" }],
        skip: page * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({
      ok: true,
      page,
      pageSize,
      total,
      items,
    });

    return;
  };

  // Canonical
  app.get("/v1/qna/questions", listHandler);
  // Alias (master-context)
  app.get("/eci/sprint13/qna/questions", listHandler);

  // Detail from DB
  app.get(
    "/v1/qna/questions/:questionId",
    asyncHandler(async (req: Request, res: Response) => {
      const connectionId = requireConnectionId(req, res);
      if (!connectionId) return;

      const questionId = String(req.params.questionId ?? "").trim();
      if (!questionId) return res.status(400).json({ error: "bad_request", message: "questionId required" });

      const q = await prisma.question.findFirst({
        where: { connectionId, marketplace: "trendyol", questionId },
        include: { answers: true },
      });
      if (!q) return res.status(404).json({ error: "not_found" });
      return res.json({ ok: true, item: q });
    })
  );

  // Answer enqueue (Write path)
  const answerHandler = asyncHandler(async (req: Request, res: Response) => {
      const connectionId = requireConnectionId(req, res);
      if (!connectionId) return;

      const questionId = String(req.params.questionId ?? "").trim();
      if (!questionId) return res.status(400).json({ error: "bad_request", message: "questionId required" });

      const parsedBody = AnswerBodySchema.safeParse(req.body);
      if (!parsedBody.success) return res.status(400).json({ error: parsedBody.error.flatten() });

      const { text, dryRun, executorApp, executorUser } = parsedBody.data;

      const q = await prisma.question.findFirst({
        where: { connectionId, marketplace: "trendyol", questionId },
        select: { id: true },
      });
      if (!q) return res.status(404).json({ error: "not_found", message: "Question not in DB. Sync first." });

      // IMPORTANT (Sprint 13): "dry" and "real" writes must NOT share idempotency.
      // Otherwise a successful dryRun (or "write disabled" safety mode) blocks the real send (mode=idempotent).
      const writeEnabledEnv = (process.env.TRENDYOL_WRITE_ENABLED ?? "").toLowerCase() === "true";
      const isDryRun = !!dryRun || !writeEnabledEnv;
      const idemMode = isDryRun ? "dry" : "real";
      const idempotencyKey = `answer:${questionId}:${sha256Hex(text).slice(0, 24)}:${idemMode}`;

      // Create a command row (idempotent by unique key)
      let cmd: { id: string; status: string } | null = null;
      try {
        cmd = await prisma.qnaCommand.create({
          data: {
            connectionId,
            marketplace: "trendyol",
            questionDbId: q.id,
            questionId,
            commandType: "answer",
            status: "queued",
            idempotencyKey,
            request: { questionId, text, dryRun: isDryRun, executorApp: executorApp ?? null, executorUser: executorUser ?? null },
          },
          select: { id: true, status: true },
        });
      } catch (e: any) {
        if (e?.code === "P2002") {
          const existing = await prisma.qnaCommand.findFirst({
            where: { connectionId, marketplace: "trendyol", idempotencyKey },
            select: { id: true, status: true },
          });
          if (existing) {
            return res.json({
              ok: true,
              mode: "idempotent",
              qnaCommandId: existing.id,
              status: existing.status,
              idempotencyKey,
            });
          }
        }
        throw e;
      }

      const jobRow = await prisma.job.create({
        data: {
          connectionId,
          type: "TRENDYOL_QNA_CREATE_ANSWER",
          status: "queued",
          startedAt: null,
          finishedAt: null,
          summary: {
            qnaCommandId: cmd.id,
            questionId,
            text,
            dryRun: isDryRun,
            executorApp: executorApp ?? null,
            executorUser: executorUser ?? null,
          },
          error: null,
        },
        select: { id: true },
      });

      await eciQueue.add(
        "TRENDYOL_QNA_CREATE_ANSWER",
        {
          jobId: jobRow.id,
          connectionId,
          params: {
            qnaCommandId: cmd.id,
            questionId,
            text,
            dryRun: isDryRun,
            executorApp: executorApp ?? null,
            executorUser: executorUser ?? null,
          },
        },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 }
      );

      return res.json({ ok: true, mode: "queued", jobId: jobRow.id, qnaCommandId: cmd.id, idempotencyKey });
    });

  app.post("/v1/qna/questions/:questionId/answers", answerHandler);
  // Alias (master-context)
  app.post("/eci/sprint13/qna/questions/:questionId/answers", answerHandler);
}
