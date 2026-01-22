import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

import { decryptJson, encryptJson } from "../src/eci/lib/crypto";
import type { TrendyolConfig } from "../src/eci/connectors/trendyol/client";

/**
 * Sprint 13 — Config helper
 * Persist TRENDYOL_SUPPLIER_ID into the latest active Trendyol connection config (cfg.supplierId).
 *
 * Why:
 * - Trendyol QnA list requires supplierId query param.
 * - In some accounts supplierId != sellerId.
 * - We want worker + probe to use a single source of truth (connection config) without manual DB edits.
 *
 * Usage:
 *   cd services/core
 *   # Ensure ECI_ENCRYPTION_KEY_BASE64 is available (same as other scripts)
 *   # Ensure TRENDYOL_SUPPLIER_ID is set in your .env (recommended)
 *   # Optionally also set TRENDYOL_SELLER_ID (strongly recommended)
 *   npx tsx scripts/set-latest-trendyol-supplierid.ts
 *
 *   # Or pass ids as CLI args:
 *   #   npx tsx scripts/set-latest-trendyol-supplierid.ts --supplierId 123 --sellerId 456
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

function parseArgs(argv: string[]) {
  // Very small parser: supports
  //   --supplierId 123  | --supplierId=123
  //   --sellerId 456    | --sellerId=456
  const out: { supplierId?: string; sellerId?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--supplierId=")) out.supplierId = a.split("=")[1]?.trim();
    else if (a === "--supplierId") out.supplierId = (argv[++i] ?? "").trim();
    else if (a.startsWith("--sellerId=")) out.sellerId = a.split("=")[1]?.trim();
    else if (a === "--sellerId") out.sellerId = (argv[++i] ?? "").trim();
    else if (!a.startsWith("--") && !out.supplierId) out.supplierId = a.trim();
    else if (!a.startsWith("--") && out.supplierId && !out.sellerId) out.sellerId = a.trim();
  }
  if (out.supplierId === "") delete out.supplierId;
  if (out.sellerId === "") delete out.sellerId;
  return out;
}

async function main() {
  const envPath = loadEnv();

  const args = parseArgs(process.argv.slice(2));

  // supplierId is required for QnA list. Try: CLI arg -> env -> fallback to sellerId.
  const envSupplier = (process.env.TRENDYOL_SUPPLIER_ID ?? "").trim();
  const envSeller = (process.env.TRENDYOL_SELLER_ID ?? "").trim();

  const supplierId = (args.supplierId ?? envSupplier ?? "").trim() || (envSeller ? envSeller : "");
  const supplierSource = args.supplierId ? "arg" : envSupplier ? "env" : envSeller ? "fallback_sellerId" : "missing";

  if (!supplierId) {
    throw new Error(
      "Missing required Trendyol id: TRENDYOL_SUPPLIER_ID (or pass --supplierId). " +
        "SupplierId is required by Trendyol QnA list."
    );
  }

  // sellerId is used in the URL path. Prefer CLI arg -> env -> keep existing cfg.sellerId.
  const desiredSellerId = (args.sellerId ?? envSeller ?? "").trim();
  const sellerSource = args.sellerId ? "arg" : envSeller ? "env" : "keep_cfg";

  const prisma = new PrismaClient();

  const conn = await prisma.connection.findFirst({
    where: {
      type: { equals: "trendyol", mode: "insensitive" },
      status: { in: ["active", "enabled"] },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, status: true, configEnc: true, updatedAt: true },
  });

  if (!conn) {
    console.log(JSON.stringify({ ok: false, reason: "no_active_trendyol_connection", envPath }, null, 2));
    return;
  }

  const cfg = decryptJson<TrendyolConfig>(conn.configEnc);
  const before = {
    sellerId: String((cfg as any)?.sellerId ?? ""),
    supplierId: (cfg as any)?.supplierId ? String((cfg as any).supplierId) : null,
    env: (cfg as any)?.env ?? null,
    baseUrl: (cfg as any)?.baseUrl ?? null,
  };

  const next: any = { ...(cfg as any), supplierId: String(supplierId).trim() };
  if (desiredSellerId) next.sellerId = String(desiredSellerId).trim();

  const updated = await prisma.connection.update({
    where: { id: conn.id },
    data: { configEnc: encryptJson(next) },
    select: { id: true, name: true, status: true, updatedAt: true },
  });

  const after = { ...before, supplierId: next.supplierId, sellerId: String(next.sellerId ?? "") };

  console.log(
    JSON.stringify(
      {
        ok: true,
        envPath,
        connection: updated,
        before,
        after,
        used: {
          supplierId: { value: next.supplierId, source: supplierSource },
          sellerId: { value: String(next.sellerId ?? ""), source: sellerSource },
        },
        note: "supplierId saved into connection config (cfg.supplierId).",
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String((e as any)?.message ?? e) }, null, 2));
  process.exit(1);
});
