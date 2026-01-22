/**
 * Sprint 13 / Step 4.x — DB smoke for QnA tables (Question/Answer) + Job lookup
 * Goal: produce DB proof output WITHOUT PowerShell quoting problems.
 *
 * Usage:
 *   cd services/core
 *   npx tsx scripts/db-qna-smoke.ts
 *   npx tsx scripts/db-qna-smoke.ts <jobId>
 */
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

function loadEnv() {
  // Prefer cwd .env (services/core/.env)
  const envPath = path.resolve(process.cwd(), ".env");
  dotenv.config({ path: envPath, override: true });
  return envPath;
}

type Out = {
  ok: boolean;
  envPath: string;
  db: {
    questionCount?: number;
    answerCount?: number;
    sampleQuestions?: Array<{ questionId: string; status: string | null; askedAt: string | null }>;
    sampleAnswers?: Array<{ questionId: string; answeredAt: string | null }>;
    job?: { id: string; type: string; status: string; summary: unknown } | null;
  };
  error?: { message: string; stack?: string };
};

async function main() {
  const envPath = loadEnv();
  const prisma = new PrismaClient();

  const jobId = process.argv[2];

  const out: Out = { ok: true, envPath, db: {} };

  try {
    out.db.questionCount = await prisma.question.count();
    out.db.answerCount = await prisma.answer.count();

    const qs = await prisma.question.findMany({
      orderBy: [{ askedAt: "desc" }],
      take: 3,
      select: { questionId: true, status: true, askedAt: true },
    });

    out.db.sampleQuestions = qs.map((q) => ({
      questionId: q.questionId,
      status: q.status,
      askedAt: q.askedAt ? q.askedAt.toISOString() : null,
    }));

    const ans = await prisma.answer.findMany({
      orderBy: [{ answeredAt: "desc" }],
      take: 3,
      select: { questionId: true, answeredAt: true },
    });

    out.db.sampleAnswers = ans.map((a) => ({
      questionId: a.questionId,
      answeredAt: a.answeredAt ? a.answeredAt.toISOString() : null,
    }));

    if (jobId) {
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { id: true, type: true, status: true, summary: true },
      });
      out.db.job = job ?? null;
    }
  } catch (e: any) {
    out.ok = false;
    out.error = { message: e?.message ?? String(e), stack: e?.stack };
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  // Always print JSON to STDOUT so Tee-Object creates a file.
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.log(
    JSON.stringify(
      { ok: false, error: { message: e?.message ?? String(e), stack: e?.stack } },
      null,
      2
    )
  );
});
