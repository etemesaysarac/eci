import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { Queue } from "bullmq";
import { PrismaClient } from "@prisma/client";

/**
 * Sprint 13 — Write path helper (NO placeholders)
 *
 * One command to:
 * 1) Read proofs/qna_probe_latest_connection.json
 * 2) Pick first WAITING_FOR_ANSWER questionId
 * 3) Ensure that question exists in local DB (if not -> enqueue TRENDYOL_SYNC_QNA_QUESTIONS and wait)
 * 4) Call local API to submit a REAL answer:
 *      POST /v1/qna/questions/:id/answers?connectionId=...
 *    using proper JSON (no PowerShell quoting pitfalls)
 * 5) Fetch /v1/jobs/recent for proof
 *
 * Usage (from services/core):
 *   npx tsx scripts/enqueue-trendyol-qna-answer-first.ts
 */

function loadEnv() {
  const envPath = (process.env.ECI_ENV_FILE ?? "").trim() || path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath, override: true });
  return envPath;
}

function safeGetFirstWaitingId(probe: any): string | null {
  const sweep = probe?.probes?.fallbackSupplier_statusSweep;
  const a = sweep?.WAITING_FOR_ANSWER?.firstQuestionIds?.[0];
  if (a != null) return String(a);

  const b = probe?.probes?.fallbackSupplier_requestedStatus?.firstQuestionIds?.[0];
  if (b != null) return String(b);

  const c = probe?.probes?.fallbackSupplier_requestedStatus?.sampleDetail?.id;
  if (c != null) return String(c);

  return null;
}

async function enqueueQnaSync(params: { connectionId: string; days: number; status: string; pageSize: number }) {
  const prisma = new PrismaClient();
  const type = "TRENDYOL_SYNC_QNA_QUESTIONS";

  const job = await prisma.job.create({
    data: {
      connectionId: params.connectionId,
      type,
      status: "queued",
      summary: { days: params.days, status: params.status, pageSize: params.pageSize },
    },
  });

  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const queue = new Queue("eci-jobs", { connection: { url: redisUrl } });

  await queue.add(
    type,
    { jobId: job.id, type, connectionId: params.connectionId, payload: { days: params.days, status: params.status, pageSize: params.pageSize } },
    { removeOnComplete: 1000, removeOnFail: 1000 }
  );

  await queue.close();
  await prisma.$disconnect();

  return { jobId: job.id, type, redisUrl };
}

async function waitForQuestionInDb(connectionId: string, questionId: string, timeoutMs: number) {
  const prisma = new PrismaClient();
  const started = Date.now();

  try {
    while (Date.now() - started < timeoutMs) {
      const q = await prisma.question.findFirst({
        where: { connectionId, marketplace: "trendyol", questionId },
        select: { id: true, status: true, askedAt: true, lastModifiedAt: true },
      });
      if (q) return { ok: true as const, questionDbId: q.id, status: q.status, askedAt: q.askedAt, lastModifiedAt: q.lastModifiedAt };

      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false as const, reason: "timeout" as const };
  } finally {
    await prisma.$disconnect();
  }
}

async function postAnswer(apiBase: string, connectionId: string, questionId: string, text: string) {
  const url = `${apiBase}/qna/questions/${encodeURIComponent(questionId)}/answers?connectionId=${encodeURIComponent(connectionId)}`;
  const body = { text, dryRun: false };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { raw };
  }

  return { ok: res.ok, status: res.status, url, response: parsed };
}

async function getRecentJobs(apiBase: string, connectionId: string) {
  const url = `${apiBase}/jobs/recent?connectionId=${encodeURIComponent(connectionId)}&limit=5`;
  try {
    const res = await fetch(url);
    const raw = await res.text();
    return { ok: res.ok, status: res.status, url, response: JSON.parse(raw) };
  } catch (e: any) {
    return { ok: false, status: 0, url, response: { error: String(e?.message ?? e) } };
  }
}

async function main() {
  const envPath = loadEnv();

  const proofPath = path.join(process.cwd(), "proofs", "qna_probe_latest_connection.json");
  if (!fs.existsSync(proofPath)) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: "proof_missing",
          message:
            "proofs/qna_probe_latest_connection.json not found. First run: npx tsx scripts/qna-probe-latest-connection.ts WAITING_FOR_ANSWER 50",
          cwd: process.cwd(),
          expectedProof: proofPath,
          envPath,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const probe = JSON.parse(fs.readFileSync(proofPath, "utf-8"));
  const connectionId = String(probe?.connection?.id ?? "").trim();
  if (!connectionId) throw new Error("connectionId missing in proof file.");

  const questionId = safeGetFirstWaitingId(probe);
  if (!questionId) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: "no_waiting_questions",
          message:
            "Probe shows no WAITING_FOR_ANSWER. Create a new question in Trendyol panel (do NOT answer), rerun probe, then rerun this script.",
          connectionId,
        },
        null,
        2
      )
    );
    process.exit(2);
  }

  const apiBase = (process.env.ECI_LOCAL_API_BASE ?? "").trim() || "http://127.0.0.1:3001/v1";

  // Answer text (10–2000 chars). Include timestamp so you can prove it's the one from ECI.
  const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  const answerText =
    (process.env.QNA_ANSWER_TEXT ?? "").trim() ||
    `Merhaba! Hemen yardımcı olalım. Rica etsem detay paylaşır mısınız? (ECI Sprint13 ${stamp})`;

  // Ensure the question exists in local DB; if not, enqueue sync and wait.
  const prisma = new PrismaClient();
  const exists = await prisma.question.findFirst({
    where: { connectionId, marketplace: "trendyol", questionId },
    select: { id: true },
  });
  await prisma.$disconnect();

  let sync: any = null;
  let dbWait: any = null;

  if (!exists) {
    sync = await enqueueQnaSync({ connectionId, days: 14, status: "WAITING_FOR_ANSWER", pageSize: 50 });
    dbWait = await waitForQuestionInDb(connectionId, questionId, 60000);
    if (!dbWait.ok) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            step: "wait_for_db",
            connectionId,
            questionId,
            sync,
            dbWait,
            hint:
              "Worker must be running to process the sync job: npm run eci:worker (services/core). Check Redis/Postgres containers too.",
          },
          null,
          2
        )
      );
      process.exit(3);
    }
  } else {
    dbWait = { ok: true, note: "question already in DB" };
  }

  // Post answer via API
  let post: any = null;
  try {
    post = await postAnswer(apiBase, connectionId, questionId, answerText);
  } catch (e: any) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          step: "post_answer",
          error: String(e?.message ?? e),
          apiBase,
          hint: "API is likely not running. Start it: npm run eci:api (services/core).",
        },
        null,
        2
      )
    );
    process.exit(4);
  }

  if (!post.ok) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          step: "post_answer",
          post,
          hint:
            "If you see 'write_disabled', set TRENDYOL_WRITE_ENABLED=true in services/core/.env then restart API+Worker. If you see 'not_found', rerun this script (it auto-syncs once, but worker must be up).",
        },
        null,
        2
      )
    );
    process.exit(5);
  }

  // Fetch recent jobs for proof
  const recentJobs = await getRecentJobs(apiBase, connectionId);

  console.log(
    JSON.stringify(
      {
        ok: true,
        envPath,
        proofPath,
        apiBase,
        connectionId,
        selectedQuestionId: questionId,
        sync,
        dbWait,
        post,
        recentJobs,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
