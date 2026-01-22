import fs from "fs";
import path from "path";
import dotenv from "dotenv";

import { prisma } from "../src/eci/prisma";
import { decryptJson, encryptJson } from "../src/eci/lib/crypto";
import {
  TrendyolConfig,
  trendyolQnaQuestionsFilter,
  trendyolQnaQuestionById,
  QnaQuestionsFilterQuery,
} from "../src/eci/connectors/trendyol/client";

function uniq<T>(arr: T[]): T[] {
  const out: T[] = [];
  const s = new Set<string>();
  for (const v of arr) {
    const k = typeof v === "string" ? v : JSON.stringify(v);
    if (s.has(k)) continue;
    s.add(k);
    out.push(v);
  }
  return out;
}

function loadEnv() {
  const envPath = process.env.ECI_ENV_FILE
    ? path.resolve(process.cwd(), process.env.ECI_ENV_FILE)
    : path.resolve(process.cwd(), ".env");

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }

  return { envPath };
}

function inferEnvFromBaseUrl(baseUrl: string | null | undefined): "prod" | "stage" {
  const u = String(baseUrl ?? "").toLowerCase();
  return u.includes("stage") ? "stage" : "prod";
}

function normId(v: any): string {
  const s = String(v ?? "").trim();
  return s;
}

type ProbeRow = {
  baseUrl: string;
  env: "prod" | "stage";
  sellerId: string;
  supplierId: string;
  status: string;
  ok: boolean;
  totalElements?: number;
  firstQuestionIds?: string[];
  sampleDetail?: any;
  error?: string;
};

async function probeOnce(cfg: TrendyolConfig, status: string, size: number): Promise<ProbeRow> {
  const baseUrl = String((cfg as any)?.baseUrl ?? "").trim() || "(none)";
  const env = inferEnvFromBaseUrl(baseUrl);

  try {
    const q: QnaQuestionsFilterQuery = {
      supplierId: (cfg as any).supplierId ?? cfg.sellerId,
      status,
      page: 0,
      size,
    };

    const data: any = await trendyolQnaQuestionsFilter(cfg, q);

    const content: any[] = Array.isArray(data?.content) ? data.content : [];
    const totalElements = typeof data?.totalElements === "number" ? data.totalElements : content.length;
    const ids = content
      .map((x) => String(x?.id ?? x?.questionId ?? "").trim())
      .filter(Boolean)
      .slice(0, 3);

    let sampleDetail: any = null;
    if (ids[0]) {
      try {
        sampleDetail = await trendyolQnaQuestionById(cfg, ids[0]);
      } catch {
        // ignore (detail may be restricted)
      }
    }

    return {
      baseUrl,
      env,
      sellerId: String((cfg as any).sellerId),
      supplierId: String((cfg as any).supplierId ?? ""),
      status,
      ok: true,
      totalElements,
      firstQuestionIds: ids,
      sampleDetail,
    };
  } catch (e: any) {
    return {
      baseUrl,
      env,
      sellerId: String((cfg as any).sellerId),
      supplierId: String((cfg as any).supplierId ?? ""),
      status,
      ok: false,
      error: String(e?.message ?? e),
    };
  }
}

async function main() {
  const { envPath } = loadEnv();

  const requestedStatus = String(process.argv[2] ?? "").trim() || "WAITING_FOR_ANSWER";
  const size = Math.min(Math.max(Number(process.argv[3] ?? 5) || 5, 1), 50);

  const isActive = (s?: string | null) => {
    const v = String(s ?? "").toLowerCase();
    return v === "active" || v === "enabled";
  };

  const rowsConn = await prisma.connection.findMany({
    where: { type: { equals: "trendyol", mode: "insensitive" } },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { id: true, name: true, type: true, status: true, configEnc: true, updatedAt: true, createdAt: true },
  });

  let conn = rowsConn.find((r) => isActive(r.status)) ?? rowsConn[0];
  if (!conn) {
    const lastJob = await prisma.job.findFirst({
      where: { type: "TRENDYOL_SYNC_QNA_QUESTIONS" },
      orderBy: { createdAt: "desc" },
      select: { connectionId: true },
    });
    if (lastJob?.connectionId) {
      conn = await prisma.connection.findUnique({
        where: { id: lastJob.connectionId },
        select: { id: true, name: true, type: true, status: true, configEnc: true, updatedAt: true, createdAt: true },
      });
    }
  }

  if (!conn) {
    console.log(JSON.stringify({ ok: false, reason: "no_trendyol_connection", envPath }, null, 2));
    return;
  }

  const cfg0 = decryptJson<TrendyolConfig>(conn.configEnc);

  const current = {
    sellerId: normId((cfg0 as any)?.sellerId),
    supplierId: normId((cfg0 as any)?.supplierId),
    env: (cfg0 as any)?.env ?? null,
    baseUrl: (cfg0 as any)?.baseUrl ?? null,
  };

  const envSeller = normId(process.env.TRENDYOL_SELLER_ID);
  const envSupplier = normId(process.env.TRENDYOL_SUPPLIER_ID);

  const baseUrlCandidates = uniq(
    [
      normId((cfg0 as any)?.baseUrl),
      "https://apigw.trendyol.com",
      "https://stageapigw.trendyol.com",
    ].filter(Boolean)
  );

  const sellerIdCandidates = uniq([current.sellerId, current.supplierId, envSeller, envSupplier].filter(Boolean));
  const supplierIdCandidates = uniq([current.supplierId, current.sellerId, envSupplier, envSeller].filter(Boolean));

  const statusesToTry = uniq([
    requestedStatus,
    "WAITING_FOR_ANSWER",
    "ANSWERED",
    "WAITING_FOR_APPROVE",
    "REJECTED",
    "REPORTED",
  ].filter(Boolean));

  const rows: ProbeRow[] = [];

  for (const baseUrl of baseUrlCandidates) {
    for (const sellerId of sellerIdCandidates) {
      for (const supplierId of supplierIdCandidates) {
        // cheap early skip: empty strings
        if (!sellerId || !supplierId) continue;

        // Probe only one status first (requested). Only if 0, expand to sweep.
        const cfg1: TrendyolConfig = {
          ...(cfg0 as any),
          sellerId,
          supplierId,
          baseUrl,
          env: inferEnvFromBaseUrl(baseUrl),
        };

        const first = await probeOnce(cfg1, requestedStatus, size);
        rows.push(first);

        const hit = first.ok && (first.totalElements ?? 0) > 0;
        if (!hit) {
          for (const st of statusesToTry) {
            if (st === requestedStatus) continue;
            const r = await probeOnce(cfg1, st, Math.min(size, 5));
            rows.push(r);
            if (r.ok && (r.totalElements ?? 0) > 0) break;
          }
        }
      }
    }
  }

  // Best hit selection
  const hits = rows.filter((r) => r.ok && (r.totalElements ?? 0) > 0);

  const score = (r: ProbeRow) => {
    const total = Number(r.totalElements ?? 0);
    let s = total * 1000;
    if (current.baseUrl && r.baseUrl === current.baseUrl) s += 50;
    if (r.sellerId === current.sellerId) s += 10;
    if (r.supplierId === current.supplierId) s += 5;
    if (r.sellerId === r.supplierId) s += 2;
    return s;
  };

  const best = hits.sort((a, b) => score(b) - score(a))[0] ?? null;

  let applied: any = null;
  if (best) {
    const next: any = {
      ...(cfg0 as any),
      sellerId: best.sellerId,
      supplierId: best.supplierId,
      baseUrl: best.baseUrl,
      env: best.env,
    };

    const enc = encryptJson(next);
    await prisma.connection.update({
      where: { id: conn.id },
      data: { configEnc: enc },
      select: { id: true },
    });

    applied = {
      connectionId: conn.id,
      before: current,
      after: {
        sellerId: best.sellerId,
        supplierId: best.supplierId,
        env: best.env,
        baseUrl: best.baseUrl,
      },
      reason: "best_hit_totalElements>0",
    };
  }

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
    current,
    envIds: {
      TRENDYOL_SELLER_ID: envSeller || null,
      TRENDYOL_SUPPLIER_ID: envSupplier || null,
    },
    candidates: {
      baseUrlCandidates,
      sellerIdCandidates,
      supplierIdCandidates,
      statusesToTry,
      requested: { status: requestedStatus, size },
    },
    best,
    applied,
    rows,
  };

  const proofsDir = path.resolve(process.cwd(), "proofs");
  fs.mkdirSync(proofsDir, { recursive: true });
  const proofFile = path.join(proofsDir, "qna_probe_matrix.json");
  fs.writeFileSync(proofFile, JSON.stringify(out, null, 2), "utf-8");

  console.log(JSON.stringify(out, null, 2));
  console.log(`[qna-probe-matrix] wrote: ${proofFile}`);
}

main().catch((e) => {
  console.error(String((e as any)?.message ?? e));
  process.exit(1);
});
