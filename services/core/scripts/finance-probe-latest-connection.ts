import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

import { decryptJson } from "../src/eci/lib/crypto";
import {
  trendyolFinanceCheSettlements,
  trendyolFinanceCheOtherFinancials,
  trendyolFinanceCargoInvoiceItems,
  type TrendyolConfig,
} from "../src/eci/connectors/trendyol/client";

/**
 * Sprint 14 — Step 14.0 (diagnostic / PROBE)
 * Probe Trendyol Finance endpoints using the SAME active connection config as the worker (no manual ids).
 *
 * Produces:
 *  - proofs/finance_probe_settlements_latest_connection.json
 *  - proofs/finance_probe_otherfinancials_latest_connection.json
 *  - proofs/finance_probe_cargoInvoiceItems_sample.json (if possible)
 *
 * Run (from repo root OR from services/core):
 *   npx tsx services/core/scripts/finance-probe-latest-connection.ts
 *   # or:
 *   cd services/core && npx tsx scripts/finance-probe-latest-connection.ts
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
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function normalizeFinanceSize(v: any, fallback = 500): 500 | 1000 {
  const n = Number(v);
  if (Number.isFinite(n) && Math.trunc(n) === 1000) return 1000;
  if (Number.isFinite(n) && Math.trunc(n) === 500) return 500;
  const fb = Math.trunc(Number(fallback));
  return fb === 1000 ? 1000 : 500;
}

function resolveRepoRoot(): string {
  // Walk up a few levels and find the monorepo root (has package.json + services + apps)
  let cur = process.cwd();
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(cur, "package.json");
    const services = path.join(cur, "services");
    const apps = path.join(cur, "apps");
    if (fs.existsSync(pkg) && fs.existsSync(services) && fs.existsSync(apps)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

function safeSnippet(obj: any, max = 900) {
  try {
    const s = JSON.stringify(obj);
    return s.length <= max ? s : s.slice(0, max) + "...(truncated)";
  } catch {
    return String(obj);
  }
}

function nowMs() {
  return Date.now();
}

function daysAgoMs(days: number) {
  return nowMs() - days * 24 * 60 * 60 * 1000;
}

async function main() {
  const envPath = loadEnv();

  const windowDays = Math.min(Math.max(toInt(process.argv[2], 7), 1), 15);
  // Trendyol Finance endpoints require size ∈ {500, 1000} (observed from API 400 responses).
  const pageSize = normalizeFinanceSize(process.argv[3], 500);

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
    await prisma.$disconnect();
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

  const endDate = nowMs();
  const startDate = daysAgoMs(windowDays);

  // Candidate types (we stop at the first successful non-empty content, but still record attempts)
  const settlementTypes = ["SellerRevenuePositive", "SellerRevenueNegative", "CommissionNegative", "CommissionPositive"];
  const otherFinancialTypes = ["PaymentOrder", "WireTransfer", "CashAdvance", "Stoppage"];

  const settlements: any = { ok: false, endpointOk: false, dataOk: false, attempts: [] as any[] };
  for (const t of settlementTypes) {
    try {
      const res = await trendyolFinanceCheSettlements(cfg, {
        startDate,
        endDate,
        transactionType: t,
        page: 0,
        size: pageSize,
      });

      const attempt = {
        transactionType: t,
        ok: true,
        summary: {
          page: (res as any)?.page ?? null,
          size: (res as any)?.size ?? null,
          totalPages: (res as any)?.totalPages ?? null,
          totalElements: (res as any)?.totalElements ?? (res as any)?.total ?? null,
          contentCount: Array.isArray((res as any)?.content) ? (res as any).content.length : null,
        },
        sample: Array.isArray((res as any)?.content) && (res as any).content.length ? (res as any).content[0] : null,
      };

      settlements.attempts.push(attempt);
      settlements.endpointOk = true;

      if (Array.isArray((res as any)?.content) && (res as any).content.length > 0) {
        settlements.dataOk = true;
        settlements.chosen = t;
        settlements.result = res;
        break;
      }
    } catch (e) {
      settlements.attempts.push({ transactionType: t, ok: false, error: String((e as any)?.message ?? e) });
    }
  }
  settlements.ok = settlements.endpointOk;
  if (settlements.endpointOk && !settlements.dataOk) {
    settlements.reason = "empty_result_for_test_window_or_transactionTypes";
  }

  const otherfinancials: any = { ok: false, endpointOk: false, dataOk: false, attempts: [] as any[] };
  for (const t of otherFinancialTypes) {
    try {
      const res = await trendyolFinanceCheOtherFinancials(cfg, {
        startDate,
        endDate,
        transactionType: t,
        page: 0,
        size: pageSize,
      });

      otherfinancials.attempts.push({
        transactionType: t,
        ok: true,
        summary: {
          page: (res as any)?.page ?? null,
          size: (res as any)?.size ?? null,
          totalPages: (res as any)?.totalPages ?? null,
          totalElements: (res as any)?.totalElements ?? null,
          contentCount: Array.isArray((res as any)?.content) ? (res as any).content.length : null,
        },
        sample: Array.isArray((res as any)?.content) && (res as any).content.length ? (res as any).content[0] : null,
      });

      otherfinancials.endpointOk = true;

      if (Array.isArray((res as any)?.content) && (res as any).content.length > 0) {
        otherfinancials.dataOk = true;
        otherfinancials.chosen = t;
        otherfinancials.result = res;
        break;
      }
    } catch (e) {
      otherfinancials.attempts.push({ transactionType: t, ok: false, error: String((e as any)?.message ?? e) });
    }
  }
  otherfinancials.ok = otherfinancials.endpointOk;
  if (otherfinancials.endpointOk && !otherfinancials.dataOk) {
    otherfinancials.reason = "empty_result_for_test_window_or_transactionTypes";
  }

  // Cargo invoice sample (best-effort):
  // 1) Fetch otherfinancials with transactionType=DeductionInvoices
  // 2) Find a record that looks like a cargo invoice (transactionType contains "Kargo")
  // 3) Use its Id (invoiceSerialNumber) on /cargo-invoice/{invoiceSerialNumber}/items
  const cargo: any = { ok: false };
  try {
    const res = await trendyolFinanceCheOtherFinancials(cfg, {
      startDate: daysAgoMs(15),
      endDate,
      transactionType: "DeductionInvoices",
      page: 0,
      size: pageSize,
    });

    const rows: any[] = Array.isArray((res as any)?.content) ? (res as any).content : [];
    const cargoRow =
      rows.find((r) => String(r?.transactionType ?? r?.type ?? r?.transactionTypeName ?? "").toLowerCase().includes("kargo")) ??
      rows[0] ??
      null;

    const invoiceSerialNumber =
      cargoRow?.invoiceSerialNumber ??
      cargoRow?.invoiceSerial ??
      cargoRow?.invoiceSerialNo ??
      cargoRow?.Id ??
      cargoRow?.id ??
      null;

    cargo.deductionInvoices = {
      ok: true,
      contentCount: rows.length,
      chosenRow: cargoRow,
      invoiceSerialNumber,
    };

    if (invoiceSerialNumber != null) {
      const items = await trendyolFinanceCargoInvoiceItems(cfg, invoiceSerialNumber, { page: 0, size: pageSize });
      cargo.ok = true;
      cargo.cargoInvoiceItems = items;
    } else {
      cargo.ok = false;
      cargo.reason = "no_invoiceSerialNumber_found_in_deductionInvoices";
    }
  } catch (e) {
    cargo.ok = false;
    cargo.error = String((e as any)?.message ?? e);
  }

  const outCommon = {
    ok: true,
    envPath,
    windowDays,
    pageSize,
    connection: {
      id: conn.id,
      name: conn.name,
      type: conn.type,
      status: conn.status,
      updatedAt: conn.updatedAt,
      createdAt: conn.createdAt,
    },
    cfgInfo,
    notes: {
      otherfinancialsRule: "transactionType + startDate + endDate are mandatory; max window is 15 days; single type per request",
      cargoInvoiceRule: "invoiceSerialNumber is taken from otherfinancials transactionType=DeductionInvoices (cargo invoice record Id) then used on /cargo-invoice/{invoiceSerialNumber}/items",
    },
  };

  const repoRoot = resolveRepoRoot();
  const proofsDir = path.join(repoRoot, "proofs");
  fs.mkdirSync(proofsDir, { recursive: true });

  const proofSettlements = path.join(proofsDir, "finance_probe_settlements_latest_connection.json");
  const proofOther = path.join(proofsDir, "finance_probe_otherfinancials_latest_connection.json");
  const proofCargo = path.join(proofsDir, "finance_probe_cargoInvoiceItems_sample.json");

  const settlementsOut = { ...outCommon, probe: "settlements", settlements };
  const otherOut = { ...outCommon, probe: "otherfinancials", otherfinancials };
  const cargoOut = { ...outCommon, probe: "cargoInvoiceItems", cargo };

  fs.writeFileSync(proofSettlements, JSON.stringify(settlementsOut, null, 2), "utf-8");
  fs.writeFileSync(proofOther, JSON.stringify(otherOut, null, 2), "utf-8");
  fs.writeFileSync(proofCargo, JSON.stringify(cargoOut, null, 2), "utf-8");

  console.log(JSON.stringify({ ok: true, wrote: [proofSettlements, proofOther, proofCargo] }, null, 2));
  console.log(`[finance-probe] settlements summary: ${safeSnippet(settlements, 500)}`);
  console.log(`[finance-probe] otherfinancials summary: ${safeSnippet(otherfinancials, 500)}`);
  console.log(`[finance-probe] cargo summary: ${safeSnippet(cargo, 500)}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(String((e as any)?.message ?? e));
  process.exit(1);
});
