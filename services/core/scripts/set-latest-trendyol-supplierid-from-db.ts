import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

import { decryptJson, encryptJson } from "../src/eci/lib/crypto";
import type { TrendyolConfig } from "../src/eci/connectors/trendyol/client";

/**
 * Sprint 13 — Auto-detect supplierId from existing marketplace data in DB
 *
 * Why:
 * - Trendyol QnA list requires supplierId query param.
 * - supplierId may NOT equal sellerId.
 * - We don't want manual hunting in the seller panel.
 *
 * What it does:
 * 1) Finds the latest active Trendyol connection
 * 2) Scans existing raw payloads (Order/Product/ShipmentPackage/Claim) for raw.supplierId
 * 3) Picks the most frequent numeric supplierId
 * 4) Saves it into connection config (cfg.supplierId) (encrypted)
 *
 * Usage:
 *   cd services/core
 *   npx tsx scripts/set-latest-trendyol-supplierid-from-db.ts
 *
 * Optional:
 *   --dryRun    (prints the detected candidate without writing)
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

function hasFlag(argv: string[], flag: string) {
  return argv.some((a) => a === flag || a.startsWith(flag + "="));
}

type SupplierRow = { supplier_id: string | null; cnt: bigint | number };

async function scanTable(
  prisma: PrismaClient,
  table: string,
  connectionId: string
): Promise<Array<{ supplierId: string; cnt: number }>> {
  // Note: $queryRaw doesn't accept identifiers, so table is interpolated (safe because we control it).
  const sql = `
    select raw->>'supplierId' as supplier_id, count(*)::bigint as cnt
    from "${table}"
    where "connectionId" = $1
      and marketplace = 'trendyol'
      and raw ? 'supplierId'
    group by 1
    order by cnt desc
    limit 25
  `;

  const rows = (await prisma.$queryRawUnsafe<SupplierRow[]>(sql, connectionId)) ?? [];
  const out: Array<{ supplierId: string; cnt: number }> = [];
  for (const r of rows) {
    const v = (r as any)?.supplier_id;
    if (!v) continue;
    const s = String(v).trim();
    if (!/^\d+$/.test(s)) continue;
    const c = Number((r as any)?.cnt ?? 0);
    if (!Number.isFinite(c) || c <= 0) continue;
    out.push({ supplierId: s, cnt: c });
  }
  return out;
}

async function main() {
  const envPath = loadEnv();
  const dryRun = hasFlag(process.argv.slice(2), "--dryRun");

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

  const tables = ["Order", "Product", "ShipmentPackage", "Claim"];
  const allCandidates: Record<string, number> = {};
  const perTable: Record<string, Array<{ supplierId: string; cnt: number }>> = {};

  for (const t of tables) {
    const rows = await scanTable(prisma, t, conn.id);
    perTable[t] = rows;
    for (const r of rows) {
      allCandidates[r.supplierId] = (allCandidates[r.supplierId] ?? 0) + r.cnt;
    }
  }

  const sorted = Object.entries(allCandidates)
    .map(([supplierId, cnt]) => ({ supplierId, cnt }))
    .sort((a, b) => b.cnt - a.cnt);

  const detected = sorted[0]?.supplierId ?? null;

  if (!detected) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          envPath,
          connection: { id: conn.id, name: conn.name, status: conn.status, updatedAt: conn.updatedAt },
          before,
          reason: "supplierId_not_found_in_db",
          hint:
            "DB'de raw.supplierId bulunamadı. Trendyol verisi yoksa normal. Çözüm: `npx tsx scripts/set-latest-trendyol-supplierid.ts --supplierId <ID>` ile manuel set et.",
          perTable,
        },
        null,
        2
      )
    );
    return;
  }

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          envPath,
          connection: { id: conn.id, name: conn.name, status: conn.status, updatedAt: conn.updatedAt },
          before,
          detected: { supplierId: detected, totalMentions: sorted[0]?.cnt ?? 0 },
          candidatesTop5: sorted.slice(0, 5),
          perTable,
          note: "Dry run: config yazılmadı.",
        },
        null,
        2
      )
    );
    return;
  }

  const next: any = { ...(cfg as any), supplierId: String(detected).trim() };

  const updated = await prisma.connection.update({
    where: { id: conn.id },
    data: { configEnc: encryptJson(next) },
    select: { id: true, name: true, status: true, updatedAt: true },
  });

  const after = { ...before, supplierId: next.supplierId };

  console.log(
    JSON.stringify(
      {
        ok: true,
        envPath,
        connection: updated,
        before,
        after,
        detected: { supplierId: detected, totalMentions: sorted[0]?.cnt ?? 0 },
        candidatesTop5: sorted.slice(0, 5),
        perTable,
        note: "supplierId auto-detected from DB and saved into connection config (cfg.supplierId).",
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
