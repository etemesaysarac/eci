import "dotenv/config";
import {
  trendyolQnaQuestionsFilter,
  trendyolQnaQuestionById,
  type TrendyolConfig,
  type TrendyolQnaQuestionStatus,
} from "./client";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

async function main() {
  const sellerId = Number(mustEnv("TRENDYOL_SELLER_ID"));
  if (!Number.isFinite(sellerId)) throw new Error("TRENDYOL_SELLER_ID must be a number.");

  const apiKey = mustEnv("TRENDYOL_API_KEY");
  const apiSecret = mustEnv("TRENDYOL_API_SECRET");

  const env = (process.env.TRENDYOL_ENV?.trim() as any) || "prod";
  const baseUrl = process.env.TRENDYOL_BASE_URL?.trim() || undefined;

  // docs: supplierId zorunlu. Çoğu hesapta sellerId ile aynı.
  const supplierId = (process.env.TRENDYOL_SUPPLIER_ID?.trim() || String(sellerId)) as string;

  const statusArg = (process.argv[2]?.trim() as TrendyolQnaQuestionStatus) || "WAITING_FOR_ANSWER";

  const now = Date.now();
  const start = now - 7 * 24 * 60 * 60 * 1000; // last 7 days (docs default is 1 week if omitted)

  const cfg: TrendyolConfig = {
    env,
    baseUrl,
    sellerId,
    apiKey,
    apiSecret,
  };

  const listRes: any = await trendyolQnaQuestionsFilter(cfg, {
    supplierId,
    status: statusArg,
    startDate: start,
    endDate: now,
    page: 0,
    size: 5,
  });

  const firstQuestionIds: any[] = Array.isArray(listRes?.content) ? listRes.content.map((q: any) => q?.id).filter(Boolean) : [];
  const firstId = firstQuestionIds[0];

  let detail: any = null;
  if (firstId !== undefined && firstId !== null) {
    detail = await trendyolQnaQuestionById(cfg, firstId);
  }

  const summary = {
    sellerId,
    supplierId,
    status: statusArg,
    list: {
      page: listRes?.page,
      size: listRes?.size,
      totalElements: listRes?.totalElements,
      totalPages: listRes?.totalPages,
      firstQuestionIds: firstQuestionIds.slice(0, 3),
    },
    sampleDetail: detail
      ? {
          id: detail?.id,
          status: detail?.status,
          creationDate: detail?.creationDate,
          productName: detail?.productName,
          textSnippet: typeof detail?.text === "string" ? (detail.text.length > 80 ? detail.text.slice(0, 80) + "…" : detail.text) : null,
        }
      : null,
  };

  // IMPORTANT: do NOT print secrets.
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
