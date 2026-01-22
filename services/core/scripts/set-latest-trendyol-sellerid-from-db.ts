import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

import { decryptJson, encryptJson } from "../src/eci/lib/crypto";
import type { TrendyolConfig } from "../src/eci/connectors/trendyol/client";

/**
 * Sprint 13 — Auto-detect sellerId (path param) from existing marketplace data in DB
 *
 * Why:
 * - Trendyol QnA list uses URL: /integration/qna/sellers/{sellerId}/questions/filter
 * - sellerId may NOT equal supplierId.
 * - We want to avoid manual hunting in the seller panel.
 *
 * What it does:
 * 1) Finds the latest active Trendyol connection
 * 2) Scans existing raw payloads (Order/Product/ShipmentPackage/Claim) for common seller id keys
 *    - raw.sellerId
 *    - raw.merchantId
 *    - raw.saticiId / raw.seller_id / raw.merchant_id (best-effort)
 * 3) Picks the most frequent numeric candidate
 * 4) Saves it into connection config (cfg.sellerId) (encrypted)
 *
 * Usage:
 *   cd services/core
 *   npx tsx scripts/set-latest-trendyol-sellerid-from-db.ts
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

type Row = { id_value: string | null; cnt: bigint | number };

const KEY_CANDIDATES = [
  "sellerId",
  "merchantId",
  "saticiId",
  "seller_id",
  "merchant_id",
  "trendyolSellerId",
];

async function scanTable(
  prisma: PrismaClient,
  table: string,
  connectionId: string
): Promise<Record<string, Array<{ value: string; cnt: number }>>> {
  const out: Record<string, Array<{ value: string; cnt: number }>> = {};

  for (const k of KEY_CANDIDATES) {
    // Note: $queryRaw doesn't accept identifiers, so table/key are interpolated.
    // Both are controlled by us (constant list).
    const sql = `
      select raw->>'${k}' as id_value, count(*)::bigint as cnt
      from "${table}"
      where "connectionId" = $1
        and marketplace = 'trendyol'
        and raw ? '${k}'
      group by 1
      order by cnt desc
      limit 25
    `;

    const rows = (await prisma.$queryRawUnsafe<Row[]>(sql, connectionId)) ?? [];
    const parsed: Array<{ value: string; cnt: number }> = [];

    for (const r of rows) {
      const v = (r as any)?.id_value;
      if (!v) continue;
      const s = String(v).trim();
      if (!/^\d+$/.test(s)) continue;
      const c = Number((r as any)?.cnt ?? 0);
      if (!Number.isFinite(c) || c <= 0) continue;
      parsed.push({ value: s, cnt: c });
    }

    if (parsed.length) out[k] = parsed;
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
  const perTable: Record<string, any> = {};
  const allCandidates: Record<string, number> = {};

  for (const t of tables) {
    const perKey = await scanTable(prisma, t, conn.id);
    perTable[t] = perKey;

    for (const [key, rows] of Object.entries(perKey)) {
      for (const r of rows) {
        allCandidates[r.value] = (allCandidates[r.value] ?? 0) + r.cnt;
      }
    }
  }

  const sorted = Object.entries(allCandidates)
    .map(([value, cnt]) => ({ sellerId: value, cnt }))
    .sort((a, b) => b.cnt - a.cnt);

  const detected = sorted[0]?.sellerId ?? null;

  if (!detected) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          envPath,
          connection: { id: conn.id, name: conn.name, status: conn.status, updatedAt: conn.updatedAt },
          before,
          reason: "sellerId_not_found_in_db",
          hint:
            "DB'de raw.* içinde sellerId/merchantId benzeri bir alan bulunamadı. Bu durumda sellerId genelde satıcı panelindeki entegrasyon bilgilerinde yer alır. Kolay yol: `npx tsx scripts/set-latest-trendyol-supplierid.ts --sellerId <ID>` ile manuel set.",
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
          detected: { sellerId: detected, totalMentions: sorted[0]?.cnt ?? 0 },
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

  const next: any = { ...(cfg as any), sellerId: String(detected).trim() };

  const updated = await prisma.connection.update({
    where: { id: conn.id },
    data: { configEnc: encryptJson(next) },
    select: { id: true, name: true, status: true, updatedAt: true },
  });

  const after = { ...before, sellerId: next.sellerId };

  console.log(
    JSON.stringify(
      {
        ok: true,
        envPath,
        connection: updated,
        before,
        after,
        detected: { sellerId: detected, totalMentions: sorted[0]?.cnt ?? 0 },
        candidatesTop5: sorted.slice(0, 5),
        perTable,
        note: "sellerId auto-detected from DB and saved into connection config (cfg.sellerId).",
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
