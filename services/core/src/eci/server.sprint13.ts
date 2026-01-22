/*
Sprint 13 — QnA (Questions & Answers)
====================================

Scope (Step 5.1 - Read path, minimal):
  - GET /v1/qna/questions?connectionId=...&status=...&page=0&pageSize=50&from=...&to=...
  - Reads from DB (Question table) only.

Notes:
  - connectionId is required (multi-tenant safety)
  - pageSize is clamped to max 50
  - from/to are optional epoch-ms filters applied to askedAt
*/

import type express from "express";
import { z } from "zod";
import { prisma } from "./prisma";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

const ListSchema = z.object({
  connectionId: z.string().min(1),
  status: z.string().min(1).optional(),
  page: z.coerce.number().int().min(0).default(0),
  pageSize: z.coerce.number().int().min(1).default(50),
  from: z.coerce.number().int().optional(), // epoch ms
  to: z.coerce.number().int().optional(),   // epoch ms
});

export function registerSprint13QnaRoutes(app: express.Express) {
  app.get("/v1/qna/questions", async (req, res) => {
    const parsed = ListSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "bad_request", issues: parsed.error.issues });
    }

    const { connectionId, status, page, from, to } = parsed.data;
    const pageSize = clamp(parsed.data.pageSize, 1, 50);

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
  });
}
