import axios, { AxiosError } from "axios";

type TrendyolEnv = "prod" | "stage";

export type TrendyolConfig = {
  sellerId: string;
  env?: TrendyolEnv;

  // optional: override API base URL (for mocks/proxies), e.g. http://127.0.0.1:3999
  baseUrl?: string;

  // optional axios timeout
  timeoutMs?: number;

  // auth
  token?: string; // base64(apiKey:apiSecret) veya "Basic <base64>" olabilir
  apiKey?: string;
  apiSecret?: string;

  // required headers
  agentName?: string; // x-agentname
  integrationName?: string; // User-Agent: "<sellerId> - <integrationName>"

  preferSapigw?: boolean;

  // Debug: /shipment-packages kök endpoint'i bazı ortamlarda 401/403 dönebiliyor.
  // Connection test'i şişirmemek için varsayılan olarak probe ETMEYİZ; true yaparsan ayrıca dener.
  probeLegacy?: boolean;
};

function normalizeBasicToken(token: string): string {
  const t = token.trim();
  if (!t) return t;
  if (t.toLowerCase().startsWith("basic ")) return t.slice(6).trim();
  return t;
}

function basicFromConfig(cfg: TrendyolConfig): string {
  const token = cfg.token?.trim();
  if (token) return normalizeBasicToken(token);

  const apiKey = cfg.apiKey?.trim();
  const apiSecret = cfg.apiSecret?.trim();

  if (apiKey && apiSecret) {
    const pair = `${apiKey}:${apiSecret}`;
    return Buffer.from(pair, "utf8").toString("base64");
  }

  throw new Error("Trendyol auth missing: provide token OR apiKey+apiSecret");
}

function envToIntegrationBaseUrl(env: TrendyolEnv): string {
  return env === "stage" ? "https://stageapigw.trendyol.com" : "https://apigw.trendyol.com";
}

function envToSapigwBaseUrl(env: TrendyolEnv): string {
  // Bazı dokümanlarda sapigw bu hostta geçiyor.
  // Cloudflare 403 gibi problemler görürsen bu yol “network/WAF” tarafıdır.
  return env === "stage" ? "https://stageapi.trendyol.com" : "https://api.trendyol.com";
}

function stripTrailingSlashes(u: string): string {
  return u.replace(/\/+$/, "");
}

function resolveIntegrationBaseUrl(cfg: TrendyolConfig): string {
  const env = cfg.env ?? "prod";
  const override = cfg.baseUrl?.trim();
  if (override) return stripTrailingSlashes(override);

  // Prefer repo-level .env when present (root: TRENDYOL_BASE_URL / optional TRENDYOL_SAPIGW_BASE_URL)
  // This matches how we run locally (C:\dev\eci\.env).
  if (cfg.preferSapigw) {
    const sapigw = process.env.TRENDYOL_SAPIGW_BASE_URL?.trim();
    if (sapigw) return stripTrailingSlashes(sapigw);
    return stripTrailingSlashes(envToSapigwBaseUrl(env));
  }

  const apigw = process.env.TRENDYOL_BASE_URL?.trim();
  if (apigw) return stripTrailingSlashes(apigw);

  // Final fallback: use the hardcoded mapping.
  return stripTrailingSlashes(envToIntegrationBaseUrl(env));
}

function buildHeaders(cfg: TrendyolConfig) {
  const sellerId = String(cfg.sellerId ?? "").trim();
  const agentName = String(cfg.agentName ?? "Easyso").trim();
  const integrationName = String(cfg.integrationName ?? "ECI").trim();
  const basic = basicFromConfig(cfg);

  return {
    Authorization: `Basic ${basic}`,
    "x-agentname": agentName,
    "User-Agent": `${sellerId} - ${integrationName}`,
    Accept: "application/json",
  };
}

function snippet(data: unknown, max = 800): string {
  try {
    // Probe / log hijyeni: PII içerebilecek alanları dökmeyelim.
    // Trendyol orders response genelde { totalElements, totalPages, page, size, content:[...] } şeklinde.
    if (data && typeof data === "object") {
      const d: any = data as any;

      const out: any = {};
      for (const k of ["totalElements", "totalPages", "page", "size", "numberOfElements"]) {
        if (typeof d[k] === "number") out[k] = d[k];
      }

      if (Array.isArray(d.content) && d.content.length > 0) {
        const first: any = d.content[0] ?? {};
        out.sample = {
          orderNumber: first.orderNumber ?? first.orderNo ?? undefined,
          shipmentPackageId: first.shipmentPackageId ?? first.packageId ?? undefined,
          status: first.status ?? undefined,
          orderDate: first.orderDate ?? undefined,
        };
      }

      if (Object.keys(out).length > 0) {
        const s = JSON.stringify(out);
        return s.length > max ? s.slice(0, max) + "…" : s;
      }

      // generic: sadece anahtar listesini göster (PII riski düşük)
      const keys = Object.keys(d).slice(0, 20);
      const s = JSON.stringify({ keys });
      return s.length > max ? s.slice(0, max) + "…" : s;
    }

    const s = typeof data === "string" ? data : String(data);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}

async function httpGetJson<T>(
  url: string,
  cfg: TrendyolConfig,
  params?: Record<string, any>,
): Promise<{ status: number; data: T; url: string }> {
  const headers = buildHeaders(cfg);

  const res = await axios.get(url, {
    headers,
    params,
    timeout: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : undefined,
    validateStatus: () => true, // 401/403/429/5xx dahil yakalayalım
  });

  return { status: res.status, data: res.data as T, url };
}

async function tryGet(url: string, cfg: TrendyolConfig) {
  const { status, data } = await httpGetJson<any>(url, cfg);
  return {
    url,
    status,
    dataSnippet: snippet(data),
  };
}

export type TrendyolFetchInit = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: any; // string or object
  params?: Record<string, any>;
};

/**
 * Sprint 8 helper: generic Trendyol request wrapper (used by webhook endpoints).
 * - Always sends required Trendyol headers (Authorization + User-Agent + x-agentname).
 * - Returns response body (JSON) on 2xx.
 * - Throws with a helpful snippet on non-2xx (includes 4xx business errors).
 */
export async function trendyolFetch<T = any>(
  cfg: TrendyolConfig,
  url: string,
  init?: TrendyolFetchInit,
): Promise<T> {
  const method = (init?.method ?? "GET") as string;
  const headers = { ...buildHeaders(cfg), ...(init?.headers ?? {}) };

  const res = await axios.request({
    url,
    method,
    headers,
    params: init?.params,
    data: init?.body,
    timeout: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : undefined,
    validateStatus: () => true,
  });

  if (res.status >= 200 && res.status < 300) return res.data as T;

  // Provide payload snippet for debugging (truncated to keep logs readable)
  throw new Error(`Trendyol webhook ${method} ${url} failed (${res.status}) :: ${snippet(res.data)}`);
}


export type OrdersQuery = {
  status?: string;
  page?: number;
  size?: number;
  startDate?: number;
  endDate?: number;
  orderByField?: string;
  orderByDirection?: "ASC" | "DESC";
};

export async function trendyolGetOrders(cfg: TrendyolConfig, q: OrdersQuery) {

  const status = q.status ?? "Created";
  const page = q.page ?? 0;
  const size = q.size ?? 50;

  const startDate = q.startDate;
  const endDate = q.endDate;

  const orderByField = q.orderByField ?? "PackageLastModifiedDate";
  const orderByDirection = q.orderByDirection ?? "DESC";

  const base = resolveIntegrationBaseUrl(cfg);

  // Trendyol dokümantasyonundaki önerilen sipariş listeleme endpoint'i
  // (“getShipmentPackages” örnekleri /orders üzerinden veriliyor.)
  const url = `${base}/integration/order/sellers/${cfg.sellerId}/orders`;

  const params: Record<string, any> = {
    status,
    page,
    size,
    orderByField,
    orderByDirection,
  };

  if (typeof startDate === "number") params.startDate = startDate;
  if (typeof endDate === "number") params.endDate = endDate;

  const res = await httpGetJson<any>(url, cfg, params);

  if (res.status >= 200 && res.status < 300) return res.data;

  throw new Error(`Trendyol request failed (${res.status}) ${url} :: ${snippet(res.data)}`);
}

// Backward-compat: eski isim halen import eden yerler için.
export const trendyolGetShipmentPackages = trendyolGetOrders;

/**
 * Teşhis: Connection test / smoke test için “tek doğru kapı”dan probe.
 * Varsayılan: sadece /orders dener.
 * Debug istersen: cfg.probeLegacy=true yapınca /shipment-packages kök endpoint’ini de ayrıca dener.
 */


// -----------------------------
// Sprint 9 — Product Catalog (Read Path)
// -----------------------------

export type TrendyolBrandsQuery = {
  page?: number;
  size?: number;
};

export async function trendyolGetBrands(cfg: TrendyolConfig, q: TrendyolBrandsQuery = {}) {
  const base = resolveIntegrationBaseUrl(cfg);
  const url = `${base}/integration/product/brands`;
  return trendyolFetch(cfg, url, { params: { page: q.page ?? 0, size: q.size ?? 50 } });
}

export async function trendyolGetProductCategories(cfg: TrendyolConfig) {
  const base = resolveIntegrationBaseUrl(cfg);
  const url = `${base}/integration/product/product-categories`;
  return trendyolFetch(cfg, url);
}

export async function trendyolGetCategoryAttributes(cfg: TrendyolConfig, categoryId: string) {
  const base = resolveIntegrationBaseUrl(cfg);
  const url = `${base}/integration/product/product-categories/${encodeURIComponent(String(categoryId))}/attributes`;
  return trendyolFetch(cfg, url);
}

export type TrendyolProductFilterQuery = {
  approved?: boolean;
  page?: number;
  size?: number;
  barcode?: string;
  productCode?: string;
};

export async function trendyolGetProducts(cfg: TrendyolConfig, q: TrendyolProductFilterQuery = {}) {
  const base = resolveIntegrationBaseUrl(cfg);
  const sellerId = String(cfg.sellerId ?? "").trim();
  const url = `${base}/integration/product/sellers/${encodeURIComponent(sellerId)}/products`;

  const params: Record<string, any> = {
    page: q.page ?? 0,
    size: q.size ?? 50,
  };

  if (typeof q.approved === "boolean") params.approved = q.approved;
  if (q.barcode) params.barcode = q.barcode;
  if (q.productCode) params.productCode = q.productCode;

  return trendyolFetch(cfg, url, { params });
}
export async function trendyolProbeShipmentPackages(cfg: TrendyolConfig) {

  // Connection test / smoke test için: çalışan kapıdan (orders) probe yapıyoruz.
  // /shipment-packages kök endpoint’i bazı hesaplarda 401/403 dönebiliyor; o yüzden sadece debug modda deneriz.
  const base = resolveIntegrationBaseUrl(cfg);

  const recommendedUrl =
    `${base}/integration/order/sellers/${cfg.sellerId}` +
    `/orders?status=Created&size=1&page=0`;

  const legacyUrl =
    `${base}/integration/order/sellers/${cfg.sellerId}` +
    `/shipment-packages?status=Created&size=1&page=0`;

  const urls = [recommendedUrl, ...(cfg.probeLegacy ? [legacyUrl] : [])];

  const results: Array<{ url: string; status: number; dataSnippet: string }> = [];
  for (const url of urls) {
    try {
      results.push(await tryGet(url, cfg));
    } catch (e) {
      const err = e as AxiosError;
      results.push({
        url,
        status: -1,
        dataSnippet: err.message,
      });
    }
  }

  const primary = results[0];
  const ok = !!primary && primary.status >= 200 && primary.status < 300;

  return { ok, primaryUrl: recommendedUrl, results };
}

function parseHttpStatusFromErrorMessage(msg: string): number | null {
  const m = /failed\s*\((\d{3})\)/i.exec(msg);
  if (m) return Number(m[1]) || null;
  return null;
}

export function shouldRetry(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  const code = parseHttpStatusFromErrorMessage(msg);
  if (!code) return false;
  if (code === 429) return true;
  if (code >= 500 && code < 600) return true;
  // 401/403 gibi durumları retry etmiyoruz; genelde credential/header/WAF problemdir
  return false;
}

export function normalizeConfig(cfg: TrendyolConfig): TrendyolConfig {
  const sellerId = String(cfg.sellerId ?? "").trim();
  const tokenRaw = cfg.token != null ? String(cfg.token).trim() : undefined;
  const apiKey = cfg.apiKey != null ? String(cfg.apiKey).trim() : undefined;
  const apiSecret = cfg.apiSecret != null ? String(cfg.apiSecret).trim() : undefined;

  const env = (cfg.env ?? "prod") as TrendyolEnv;

  const agentName = cfg.agentName != null ? String(cfg.agentName).trim() : undefined;
  const integrationName = cfg.integrationName != null ? String(cfg.integrationName).trim() : undefined;

  const preferSapigw = !!cfg.preferSapigw;
  const probeLegacy = !!cfg.probeLegacy;

  return {
    sellerId,
    env,
    token: tokenRaw,
    apiKey,
    apiSecret,
    agentName,
    integrationName,
    preferSapigw,
    probeLegacy,
  };
}
