/*
Finance Probe — One Window (15 days max)
Run:
  cd services/core
  npm run -s ts-node -- scripts/finance-probe-one-window.ts
Or:
  npx ts-node scripts/finance-probe-one-window.ts

Env:
  - DATABASE_URL
  - TRENDYOL_* connection config already stored in DB
*/

import "dotenv/config";
import { prisma } from "../src/eci/prisma";
import { trendyolFinanceCheSettlements, trendyolFinanceCheOtherFinancials } from "../src/eci/connectors/trendyol/client";

function days(n: number) {
  return n * 24 * 60 * 60 * 1000;
}

async function main() {
  const conn = await prisma.connection.findFirst({
    where: { type: "trendyol" },
    orderBy: { createdAt: "desc" },
    include: { trendyol: true },
  });

  if (!conn?.trendyol) throw new Error("No trendyol connection found");

  const cfg = conn.trendyol as any;

  const endDate = Date.now();
  const startDate = endDate - days(15);

  const size = 1000 as const;

  const settlements = await trendyolFinanceCheSettlements(cfg, {
    startDate,
    endDate,
    transactionType: "SellerRevenuePositive",
    page: 0,
    size,
  });

  const other = await trendyolFinanceCheOtherFinancials(cfg, {
    startDate,
    endDate,
    transactionType: "PaymentOrder",
    page: 0,
    size,
  });

  const settlementsRows = Array.isArray((settlements as any)?.content) ? (settlements as any).content : [];
  const otherRows = Array.isArray((other as any)?.content) ? (other as any).content : [];

  console.log(JSON.stringify({
    connectionId: conn.id,
    window: { startDate, endDate },
    settlements: { count: settlementsRows.length, sample: settlementsRows[0] ?? null },
    otherfinancials: { count: otherRows.length, sample: otherRows[0] ?? null },
  }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
