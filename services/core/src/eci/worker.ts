import "dotenv/config";

import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "./prisma";
import { decryptJson } from "./lib/crypto";
import {
  trendyolGetOrders,
  type OrdersQuery,
  type TrendyolConfig,
} from "./connectors/trendyol/client";

process.on("unhandledRejection", (e: unknown) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e: unknown) => console.error("[uncaughtException]", e));

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

type JobData = {
  connectionId: string;
  jobId: string;
  params?: {
    status?: string;
    startDate?: number;
    endDate?: number;
    pageSize?: number;
  } | null;
};

function nowIso() {
  return new Date().toISOString();
}

function log(msg: string, meta?: Record<string, unknown>) {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[eci-worker] ${nowIso()} ${msg}${suffix}`);
}

function parseHttpStatusFromErrorMessage(msg: string): number | null {
  // client.ts: "Trendyol shipment-packages failed (429) ..."
  const m = msg.match(/\((\d{3})\)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function shouldRetry(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  const code = parseHttpStatusFromErrorMessage(msg);
  if (!code) return false;
  if (code === 429) return true;
  if (code >= 500 && code < 600) return true;
  // 401/403 gibi durumları retry etmiyoruz; genelde credential/header/WAF problemdir
  return false;
}

function normalizeConfig(cfg: TrendyolConfig): TrendyolConfig {
  const sellerId = String(cfg.sellerId ?? "").trim();
  const tokenRaw = cfg.token != null ? String(cfg.token).trim() : undefined;
  const apiKey = cfg.apiKey != null ? String(cfg.apiKey).trim() : undefined;
  const apiSecret = cfg.apiSecret != null ? String(cfg.apiSecret).trim() : undefined;

  return {
    ...cfg,
    sellerId,
    token: tokenRaw ? tokenRaw.replace(/^Basic\s+/i, "").trim() : undefined,
    apiKey,
    apiSecret,
    agentName: String(cfg.agentName ?? "SoXYZ").trim(),
    integrationName: String(cfg.integrationName ?? "SoXYZ-ECI").trim(),
  };
}

async function syncOrders(connectionId: string, cfg: TrendyolConfig, params?: JobData["params"]) {
  const now = Date.now();
  const pageSize = params?.pageSize ?? 50;

  // Sprint 4: idempotency kanıtı ve "gerçek insert" ölçümü.
  // upserted sayacı şu an "işlenen" kayıt sayısı; insert/update ayrımı yapmıyor.
  // Bu yüzden sync öncesi/sonrası toplam kayıt sayısını ölçüyoruz.
  const countBefore = await prisma.order.count({
    where: { connectionId, marketplace: "trendyol" },
  });

  // Trendyol dokümantasyonunda startDate/endDate ile maksimum aralık 2 hafta.
  // Daha büyük aralık gelirse otomatik olarak 14 günlük pencerelere bölüyoruz.
  const MAX_WINDOW_MS = 14 * 24 * 3600 * 1000;

  const endDate = typeof params?.endDate === "number" ? params!.endDate : now;
  const startDate = typeof params?.startDate === "number" ? params!.startDate : endDate - 7 * 24 * 3600 * 1000;

  const status = (params?.status ?? "Created");

  if (!Number.isFinite(startDate) || !Number.isFinite(endDate)) {
    throw new Error("startDate/endDate must be unix epoch milliseconds");
  }
  if (startDate >= endDate) {
    throw new Error(`invalid date range: startDate(${startDate}) >= endDate(${endDate})`);
  }

  // Windows
  const windows: Array<{ start: number; end: number }> = [];
  let cursor = startDate;
  while (cursor < endDate) {
    const wEnd = Math.min(endDate, cursor + MAX_WINDOW_MS);
    windows.push({ start: cursor, end: wEnd });
    cursor = wEnd;
  }

  let upserted = 0;
  let fetched = 0;
  let requestedPages = 0;

  log("syncOrders started", {
    connectionId,
    status,
    startDate,
    endDate,
    pageSize,
    windows: windows.length,
  });

  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];

    let page = 0;
    let totalPages: number | null = null;

    log("syncOrders window started", {
      connectionId,
      window: w + 1,
      windows: windows.length,
      startDate: win.start,
      endDate: win.end,
      status,
      pageSize,
    });

    while (totalPages === null || page < totalPages) {
      const q: OrdersQuery = {
        status,
        page,
        size: pageSize,
        startDate: win.start,
        endDate: win.end,
        // orders endpoint'te orderByField destekleniyorsa iyi; desteklenmiyorsa server 400 döndürür.
        // Bu yüzden opsiyonel bırakalım: (varsayılan sıralama Trendyol tarafında olur)
        // orderByField: "PackageLastModifiedDate",
        // orderByDirection: "DESC",
      };

      const data: any = await trendyolGetOrders(cfg, q);
      requestedPages++;

      // Trendyol genelde { content, totalPages, ... } döner.
      const items: any[] =
        Array.isArray(data)
          ? data
          : Array.isArray(data?.content)
            ? data.content
            : Array.isArray(data?.orders)
              ? data.orders
              : [];

      if (typeof data?.totalPages === "number") totalPages = data.totalPages;
      if (typeof data?.pageCount === "number") totalPages = data.pageCount;

      fetched += items.length;

      for (const it of items) {
        const channelOrderId = String(
          it?.orderNumber ?? it?.orderId ?? it?.id ?? it?.shipmentPackageId ?? it?.packageId ?? ""
        );
        if (!channelOrderId) continue;

        await prisma.order.upsert({
          where: {
            connectionId_marketplace_channelOrderId: {
              connectionId,
              marketplace: "trendyol",
              channelOrderId,
            },
          },
          create: {
            connectionId,
            marketplace: "trendyol",
            channelOrderId,
            status: String(it?.status ?? status ?? ""),
            raw: it,
          },
          update: {
            status: String(it?.status ?? status ?? ""),
            raw: it,
          },
        });

        upserted++;
      }

      log("page processed", {
        connectionId,
        window: w + 1,
        windows: windows.length,
        page,
        items: items.length,
        fetched,
        upserted,
        totalPages,
      });

      if (totalPages === null && items.length < pageSize) break;

      page++;
      if (page > 1000) throw new Error("pagination safety break: page>1000");
    }

    log("syncOrders window finished", {
      connectionId,
      window: w + 1,
      windows: windows.length,
      startDate: win.start,
      endDate: win.end,
    });
  }

  log("syncOrders finished", {
    connectionId,
    fetched,
    upserted,
    requestedPages,
    windows: windows.length,
  });

  const countAfter = await prisma.order.count({
    where: { connectionId, marketplace: "trendyol" },
  });

  const inserted = Math.max(0, countAfter - countBefore);
  const updatedOrExisting = Math.max(0, fetched - inserted);

  return {
    upserted, // processed
    fetched,
    inserted,
    updatedOrExisting,
    countBefore,
    countAfter,
    status,
    startDate,
    endDate,
    pageSize,
    windows: windows.length,
    requestedPages,
  };
}

const worker = new Worker(
  "eci-jobs",
  async (job: Job<JobData, any, string>) => {
    const { connectionId, jobId, params } = job.data as JobData;

    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    log("job received", {
      name: job.name,
      jobId,
      connectionId,
      attempt,
      maxAttempts,
    });

    // startedAt'i sadece ilk denemede set etmeye çalış
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "running",
        startedAt: attempt === 1 ? new Date() : undefined,
        finishedAt: null,
        error: null,
      },
    });

    try {
      const conn = await prisma.connection.findUnique({ where: { id: connectionId } });
      if (!conn) throw new Error("connection not found: " + connectionId);

      const cfg = normalizeConfig(decryptJson<TrendyolConfig>(conn.configEnc));

      let summary: any;
      switch (job.name) {
        case "TRENDYOL_SYNC_ORDERS":
          summary = await syncOrders(connectionId, cfg, params ?? undefined);
          break;
        // Backward-compat: eski job adı.
        case "TRENDYOL_SYNC_SHIPMENT_PACKAGES":
          summary = await syncOrders(connectionId, cfg, params ?? undefined);
          break;
        default:
          throw new Error(`unknown job: ${job.name}`);
      }

      await prisma.job.update({
        where: { id: jobId },
        data: { status: "success", finishedAt: new Date(), summary, error: null },
      });

      log("job success", { name: job.name, jobId, connectionId, summary });
      return summary;
    } catch (err: any) {
      const retrying = shouldRetry(err) && attempt < maxAttempts;

      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: retrying ? "retrying" : "failed",
          finishedAt: retrying ? null : new Date(),
          error: String(err?.message ?? err),
        },
      });

      log("job error", {
        name: job.name,
        jobId,
        connectionId,
        retrying,
        attempt,
        maxAttempts,
        error: String(err?.message ?? err),
      });

      // ÖNEMLİ:
      // - retrying ise throw ederek BullMQ'nun bir sonraki denemeyi planlamasını sağlarız
      // - retrying değilse throw ETMEYİZ: 401/403 gibi credential hatalarında BullMQ tekrar tekrar vurmasın
      if (retrying) throw err;
      return { failed: true, error: String(err?.message ?? err) };
    }
  },
  { connection: redis }
);

worker.on("completed", (job) => {
  log("completed event", {
    name: job.name,
    jobId: (job.data as any)?.jobId,
    connectionId: (job.data as any)?.connectionId,
  });
});

worker.on("failed", (job, err) => {
  log("failed event", {
    name: job?.name,
    jobId: (job?.data as any)?.jobId,
    connectionId: (job?.data as any)?.connectionId,
    error: String((err as any)?.message ?? err),
  });
});

log(`pid=${process.pid} listening for jobs on queue: eci-jobs (${REDIS_URL})`);
