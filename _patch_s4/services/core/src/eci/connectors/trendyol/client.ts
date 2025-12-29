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

  // keep current default behavior (apigw), allow opt-in sapigw
  const base = cfg.preferSapigw ? envToSapigwBaseUrl(env) : envToIntegrationBaseUrl(env);
  return stripTrailingSlashes(base);
}

function buildHeaders(cfg: TrendyolConfig) {
  const sellerId = String(cfg.sellerId ?? "").trim();
  const agentName = String(cfg.agentName ?? "SoXYZ").trim();
  const integrationName = String(cfg.integrationName ?? "SoXYZ-ECI").trim();
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
    const s = typeof data === "string" ? data : JSON.stringify(data);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return String(data);
  }
}

function probeSnippet(data: unknown): string {
  try {
    const obj: any = typeof data === "string" ? JSON.parse(data) : data;
    const totalElements = obj?.totalElements;
    const totalPages = obj?.totalPages;
    const page = obj?.page;
    const size = obj?.size;
    const first = Array.isArray(obj?.content) ? obj.content[0] : undefined;
    const sample = first
      ? {
          orderNumber: first.orderNumber ?? first.orderId ?? undefined,
          shipmentPackageId: first.shipmentPackageId ?? undefined,
          status: first.status ?? first.shipmentPackageStatus ?? undefined,
        }
      : undefined;
    return JSON.stringify({ totalElements, totalPages, page, size, sample });
  } catch {
    // fallback (still bounded)
    return snippet(data);
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
    dataSnippet: probeSnippet(data),
  };
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

  throw new Error(`Trendyol orders failed (${res.status}) ${url} :: ${snippet(res.data)}`);
}

// Backward-compat: eski isim halen import eden yerler için.
export const trendyolGetShipmentPackages = trendyolGetOrders;

/**
 * Teşhis: Connection test / smoke test için “tek doğru kapı”dan probe.
 * Varsayılan: sadece /orders dener.
 * Debug istersen: cfg.probeLegacy=true yapınca /shipment-packages kök endpoint’ini de ayrıca dener.
 */
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
