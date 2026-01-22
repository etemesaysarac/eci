import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

import { decryptJson } from "../src/eci/lib/crypto";
import {
  normalizeConfig,
  trendyolQnaQuestionById,
  trendyolQnaQuestionsFilter,
  type TrendyolConfig,
} from "../src/eci/connectors/trendyol/client";

/**
 * Quick QnA probe for Sprint 13 proof.
 *
 * Goals:
 * - Don't rely on manually filled TRENDYOL_* vars (we can read the active Trendyol connection from DB).
 * - Always print a JSON result to STDOUT (so PowerShell Tee-Object can capture it).
 *
 * Usage:
 *   npx tsx scripts/probe-trendyol-qna.ts [STATUS] [CONNECTION_ID]
 *
 * Example:
 *   npx tsx scripts/probe-trendyol-qna.ts WAITING_FOR_ANSWER
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// scripts/  -> core/  -> services/  -> repo root
const CORE_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function loadEnvFile(p: string) {
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

// Load both env files if present (repo root first, then service-level overrides)
loadEnvFile(path.join(REPO_ROOT, ".env"));
loadEnvFile(path.join(CORE_ROOT, ".env"));

function mask(s?: string | null) {
  const v = String(s ?? "");
  if (!v) return "";
  if (v.length <= 6) return "*".repeat(v.length);
  return `${v.slice(0, 2)}***${v.slice(-2)}`;
}

function parseArg(name: string): string | null {
  const args = process.argv.slice(2);
  const ix = args.findIndex((a) => a === name);
  if (ix >= 0 && ix + 1 < args.length) return String(args[ix + 1] ?? "").trim() || null;
  return null;
}

function pickPositional(pos: number): string | null {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  return String(args[pos] ?? "").trim() || null;
}

function normalizeErr(e: any) {
  const msg = e?.message ? String(e.message) : String(e);
  const statusMatch = msg.match(/\bfailed\s*\((\d{3})\)\b/i);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;

  let snippet: any = undefined;
  const idx = msg.indexOf("::");
  if (idx >= 0) {
    const tail = msg.slice(idx + 2).trim();
    try {
      snippet = JSON.parse(tail);
    } catch {
      snippet = tail.slice(0, 800);
    }
  }

  return {
    name: e?.name ? String(e.name) : "Error",
    message: msg,
    status,
    snippet,
    stack: e?.stack ? String(e.stack).split("\n").slice(0, 15).join("\n") : undefined,
  };
}

async function loadTrendyolConfigFromDb(connectionIdHint?: string | null): Promise<{
  cfg: TrendyolConfig;
  meta: any;
} | null> {
  if (!process.env.DATABASE_URL) return null;

  const prisma = new PrismaClient();
  try {
    const conn = connectionIdHint
      ? await prisma.marketplaceConnection.findUnique({ where: { id: connectionIdHint } })
      : await prisma.marketplaceConnection.findFirst({
          where: { marketplace: "TRENDYOL" as any },
          orderBy: { createdAt: "desc" as any },
        });

    if (!conn?.configEnc) return null;

    const decrypted: any = decryptJson(conn.configEnc);

    // Minimal compatibility normalization
    const cfg = normalizeConfig({
      ...decrypted,
      // env fallback (only if DB blob misses these)
      sellerId: decrypted?.sellerId ?? process.env.TRENDYOL_SELLER_ID,
      apiKey: decrypted?.apiKey ?? process.env.TRENDYOL_API_KEY,
      apiSecret: decrypted?.apiSecret ?? process.env.TRENDYOL_API_SECRET,
      token: decrypted?.token ?? process.env.TRENDYOL_TOKEN,
      env: decrypted?.env ?? (process.env.TRENDYOL_ENV as any) ?? "prod",
      agentName: decrypted?.agentName ?? process.env.TRENDYOL_AGENT_NAME ?? "SoXYZ",
      integrationName: decrypted?.integrationName ?? process.env.TRENDYOL_INTEGRATION_NAME ?? "SoXYZ-ECI",
    });

    const meta = {
      source: "db",
      pickedConnectionId: conn.id,
      pickedConnectionName: conn.name,
      sellerId: String(cfg.sellerId ?? ""),
      env: cfg.env,
      baseUrl: (cfg as any).baseUrl,
      apiKeyMasked: mask((cfg as any).apiKey),
    };

    return { cfg, meta };
  } catch {
    return null;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function main() {
  const statusArg = (pickPositional(0) || "WAITING_FOR_ANSWER").trim();

  const connId = parseArg("--connectionId") || parseArg("--conn") || pickPositional(1) || process.env.ECI_TRENDYOL_CONNECTION_ID || null;

  const dbCfg = await loadTrendyolConfigFromDb(connId);

  const cfg = dbCfg?.cfg
    ? dbCfg.cfg
    : normalizeConfig({
        sellerId: process.env.TRENDYOL_SELLER_ID!,
        env: (process.env.TRENDYOL_ENV as any) || "prod",
        apiKey: process.env.TRENDYOL_API_KEY,
        apiSecret: process.env.TRENDYOL_API_SECRET,
        token: process.env.TRENDYOL_TOKEN,
        agentName: process.env.TRENDYOL_AGENT_NAME || "SoXYZ",
        integrationName: process.env.TRENDYOL_INTEGRATION_NAME || "SoXYZ-ECI",
        probeLegacy: process.env.TRENDYOL_PROBE_LEGACY === "1",
      });

  // supplierId is required by Trendyol for list/filter.
  const supplierId = String(
    process.env.TRENDYOL_SUPPLIER_ID ||
      (cfg as any).supplierId ||
      process.env.TRENDYOL_SELLER_ID ||
      cfg.sellerId ||
      ""
  ).trim();

  const list = await trendyolQnaQuestionsFilter(cfg, {
    supplierId,
    status: statusArg,
    page: 0,
    size: 10,
  });

  const content: any[] = Array.isArray((list as any)?.content) ? (list as any).content : [];
  const ids = content
    .map((q) => q?.id)
    .filter((v) => v !== undefined && v !== null)
    .slice(0, 5);

  const firstId = ids.length ? ids[0] : null;
  const detail = firstId ? await trendyolQnaQuestionById(cfg, firstId) : null;

  const summarizeQuestion = (q: any) => ({
    id: q?.id,
    status: q?.status,
    creationDate: q?.creationDate,
    productName: q?.productName,
    textPreview: String(q?.text ?? "").slice(0, 80),
  });

  const out = {
    ok: true,
    status: statusArg,
    used: dbCfg?.meta ?? {
      source: "env",
      sellerId: String(cfg.sellerId ?? ""),
      env: (cfg as any).env,
      apiKeyMasked: mask((cfg as any).apiKey),
    },
    request: { supplierId, page: 0, size: 10 },
    listMeta: {
      totalElements: (list as any)?.totalElements,
      totalPages: (list as any)?.totalPages,
      page: (list as any)?.page,
      size: (list as any)?.size,
    },
    sampleQuestions: content.slice(0, 3).map(summarizeQuestion),
    firstQuestionIds: ids,
    sampleDetail: detail ? summarizeQuestion(detail) : null,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  const err = normalizeErr(e);
  const out = {
    ok: false,
    error: err,
    hint: "If you see 401, sellerId/apiKey/apiSecret must belong to the SAME Trendyol seller account. User-Agent format should be '<sellerId> - <integrationName>'.",
  };

  // Always print to STDOUT (PowerShell pipes capture stdout)
  console.log(JSON.stringify(out, null, 2));

  // Still exit non-zero for CI/scripting
  process.exit(1);
});
