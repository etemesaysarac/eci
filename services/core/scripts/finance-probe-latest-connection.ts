/*
Finance Probe — Latest Connection (lookback windows)
Run:
  cd services/core
  npx ts-node scripts/finance-probe-latest-connection.ts

Defaults:
  - windowDays = 15 (Trendyol limit)
  - lookbackWindows = 2
  - size = 1000
*/

import "dotenv/config";
import { prisma } from "../src/eci/prisma";
import { trendyolFinanceCheSettlements, trendyolFinanceCheOtherFinancials, trendyolFinanceCargoInvoiceItems } from "../src/eci/connectors/trendyol/client";

function days(n: number) {
  return n * 24 * 60 * 60 * 1000;
}

const SETTLEMENT_TYPES = [
  "SellerRevenuePositive",
  "SellerRevenueNegative",
  "CommissionNegative",
  "CommissionPositive",
];

const OTHER_TYPES = [
  "PaymentOrder",
  "WireTransfer",
  "CashAdvance",
  "Stoppage",
  "DeductionInvoices",
];

function extractRows(resp: any): any[] {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.content)) return resp.content;
  if (Array.isArray(resp.items)) return resp.items;
  if (Array.isArray(resp.data)) return resp.data;
  return [];
}

async function main() {
  const conn = await prisma.connection.findFirst({
    where: { type: "trendyol" },
    orderBy: { createdAt: "desc" },
    include: { trendyol: true },
  });

  if (!conn?.trendyol) throw new Error("No trendyol connection found");

  const cfg = conn.trendyol as any;

  const size = 1000 as const;
  const windowDays = 15;
  const lookbackWindows = 2;

  const windows: Array<{ startDate: number; endDate: number }> = [];
  const end0 = Date.now();
  const start0 = end0 - days(windowDays);

  for (let w = 0; w < lookbackWindows; w++) {
    const startDate = start0 - w * days(windowDays);
    const endDate = startDate + days(windowDays);
    windows.push({ startDate, endDate });
  }

  const out: any = { connectionId: conn.id, windows: [] as any[] };

  const invoiceSerials = new Set<string>();

  for (const win of windows) {
    const wout: any = { window: win, settlements: {}, otherfinancials: {}, cargo: {} };

    for (const t of SETTLEMENT_TYPES) {
      const resp = await trendyolFinanceCheSettlements(cfg, { ...win, transactionType: t, page: 0, size });
      wout.settlements[t] = { count: extractRows(resp).length };
    }

    for (const t of OTHER_TYPES) {
      const resp = await trendyolFinanceCheOtherFinancials(cfg, { ...win, transactionType: t, page: 0, size });
      const rows = extractRows(resp);
      wout.otherfinancials[t] = { count: rows.length, sample: rows[0] ?? null };

      for (const r of rows) {
        const s = (r as any)?.invoiceSerialNumber ?? (r as any)?.invoiceSerialNo ?? null;
        if (s) invoiceSerials.add(String(s));
      }
    }

    out.windows.push(wout);
  }

  // cargo invoice items (best-effort)
  const serial = Array.from(invoiceSerials)[0];
  if (serial) {
    const resp = await trendyolFinanceCargoInvoiceItems(cfg, serial, { page: 0, size });
    out.cargo = { invoiceSerialNumber: serial, count: extractRows(resp).length, sample: extractRows(resp)[0] ?? null };
  } else {
    out.cargo = { invoiceSerialNumber: null, count: 0, sample: null };
  }

  console.log(JSON.stringify(out, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
