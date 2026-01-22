import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

import { decryptJson } from "../src/eci/lib/crypto";
import {
  trendyolQnaQuestionsFilter,
  trendyolQnaQuestionById,
  type TrendyolConfig,
} from "../src/eci/connectors/trendyol/client";

/**
 * Sprint 13 — Step 4.4 (diagnostic)
 * Probe Trendyol QnA list using the SAME connection config as the worker (no manual ids).
 *
 * It also does a small status sweep (fallbackSupplier) so we don't guess the wrong status enum.
 *
 * Outputs:
 * - prints JSON to stdout
 * - writes proofs/qna_probe_latest_connection.json
 *
 * Usage:
 *   cd services/core
 *   npx tsx scripts/qna-probe-latest-connection.ts
 *   npx tsx scripts/qna-probe-latest-connection.ts WAITING_FOR_ANSWER 10
 */
function loadEnv() {
  const explicit = (process.env.ECI_ENV_FILE ?? "").trim();
  const p = explicit ? path.resolve(explicit) : path.resolve(process.cwd(), ".env");
  if (fs.existsSync(p)) {
    dotenv.config({ path: p, override: true });
    return p;
  }
  dotenv.config({ override: true });
  return "(dotenv default)";
}

function toInt(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function probe(cfg: TrendyolConfig, status: string, size: number, supplierIdOverride?: string) {
  const list = await trendyolQnaQuestionsFilter(cfg, {
    status,
    page: 0,
    size,
    ...(supplierIdOverride ? { supplierId: supplierIdOverride } : {}),
  });

  const content: any[] = Array.isArray((list as any)?.content) ? (list as any).content : [];
  const totalElements = typeof (list as any)?.totalElements === "number" ? (list as any).totalElements : content.length;
  const totalPages = typeof (list as any)?.totalPages === "number" ? (list as any).totalPages : undefined;

  const firstIds = content.map((q: any) => q?.id).filter(Boolean).slice(0, 3);
  const firstId = firstIds[0];

  let detail: any = null;
  if (firstId !== undefined && firstId !== null) {
    try {
      detail = await trendyolQnaQuestionById(cfg, firstId);
    } catch {
      detail = null;
    }
  }

  return {
    totalElements,
    totalPages,
    firstQuestionIds: firstIds,
    sampleDetail: detail
      ? {
          id: (detail as any)?.id,
          status: (detail as any)?.status,
          creationDate: (detail as any)?.creationDate,
          productName: (detail as any)?.productName,
          textSnippet:
            typeof (detail as any)?.text === "string"
              ? ((detail as any).text.length > 120 ? (detail as any).text.slice(0, 120) + "…" : (detail as any).text)
              : null,
        }
      : null,
  };
}

function uniq(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const k = s.trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

async function main() {
  const envPath = loadEnv();

  const requestedStatus = (process.argv[2] ?? "WAITING_FOR_ANSWER").trim();
  const size = Math.min(Math.max(toInt(process.argv[3], 5), 1), 50);

  const prisma = new PrismaClient();

  const conn = await prisma.connection.findFirst({
    where: {
      type: { equals: "trendyol", mode: "insensitive" },
      status: { in: ["active", "enabled"] },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, type: true, status: true, configEnc: true, updatedAt: true, createdAt: true },
  });

  if (!conn) {
    const out = { ok: false, reason: "no_active_trendyol_connection", envPath };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const cfg = decryptJson<TrendyolConfig>(conn.configEnc);

  // IMPORTANT: do NOT print secrets.
  const cfgInfo = {
    sellerId: String((cfg as any)?.sellerId ?? ""),
    supplierId: (cfg as any)?.supplierId ? String((cfg as any).supplierId) : null,
    env: (cfg as any)?.env ?? null,
    baseUrl: (cfg as any)?.baseUrl ?? null,
    preferSapigw: Boolean((cfg as any)?.preferSapigw ?? false),
    agentName: (cfg as any)?.agentName ?? null,
    integrationName: (cfg as any)?.integrationName ?? null,
  };

  const envSupplier = (process.env.TRENDYOL_SUPPLIER_ID ?? "").trim();
  const hasEnvSupplier = envSupplier.length > 0;

  const probes: any = {};

  // A) Probe with env supplierId override (only for requested status)
  if (hasEnvSupplier) {
    probes.envSupplier_requestedStatus = await probe(cfg, requestedStatus, size, envSupplier);
  }

  // B) Probe without supplier override (client will default supplierId=cfg.sellerId)
  probes.fallbackSupplier_requestedStatus = await probe(cfg, requestedStatus, size);

  // C) Small status sweep (fallbackSupplier) to avoid wrong enum assumptions.
  const statusesToTry = uniq([
    requestedStatus,
    "WAITING_FOR_ANSWER",
    "ANSWERED",
    "WAITING_FOR_APPROVE",
    "REPORTED",
    "REJECTED",
  ]);

  const sweep: Record<string, any> = {};
  for (const st of statusesToTry) {
    try {
      const res = await probe(cfg, st, Math.min(size, 5));
      sweep[st] = { totalElements: res.totalElements, firstQuestionIds: res.firstQuestionIds };
      if (res.totalElements > 0 && !probes.fallbackSupplier_firstHit) {
        probes.fallbackSupplier_firstHit = { status: st, sampleDetail: res.sampleDetail };
      }
    } catch (e) {
      sweep[st] = { error: String((e as any)?.message ?? e) };
    }
  }
  probes.fallbackSupplier_statusSweep = sweep;

  const out = {
    ok: true,
    envPath,
    connection: {
      id: conn.id,
      name: conn.name,
      type: conn.type,
      status: conn.status,
      updatedAt: conn.updatedAt,
      createdAt: conn.createdAt,
    },
    cfg: cfgInfo,
    requested: { status: requestedStatus, size },
    envSupplier: hasEnvSupplier ? envSupplier : null,
    probes,
  };

  // Write proof file
  const proofsDir = path.resolve(process.cwd(), "proofs");
  fs.mkdirSync(proofsDir, { recursive: true });
  const proofFile = path.join(proofsDir, "qna_probe_latest_connection.json");
  fs.writeFileSync(proofFile, JSON.stringify(out, null, 2), "utf-8");

  console.log(JSON.stringify(out, null, 2));
  console.log(`[qna-probe] wrote: ${proofFile}`);
}

main().catch((e) => {
  console.error(String((e as any)?.message ?? e));
  process.exit(1);
});
