import axios, { AxiosError } from "axios";

type TrendyolEnv = "prod" | "stage";

export type TrendyolConfig = {
  sellerId: string;
  /**
   * Trendyol supplierId (bazı endpoint'lerde zorunlu parametre).
   * Not: Bazı hesaplarda sellerId ile aynı olabilir.
   */
  supplierId?: string;
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

/**
 * Stable/Canonical gateway base URL for endpoints documented under apigw.trendyol.com.
 *
 * Why this exists:
 * - Some seller accounts see 401/403/"WAF" style errors when hitting legacy hosts (api.trendyol.com).
 * - Trendyol.pdf examples for seller ops (addresses / commonlabel / seller-invoice-*) and recommended
 *   order listing are on apigw.trendyol.com (or stageapigw.trendyol.com).
 * - We still allow local/proxy overrides for testing.
 */
function resolveApigwBaseUrl(cfg: TrendyolConfig): string {
  const env = cfg.env ?? "prod";

  const override = cfg.baseUrl?.trim();
  if (override) {
    // If override points to Trendyol's legacy/non-apigw hosts, ignore it for apigw-canonical endpoints.
    // Non-Trendyol overrides (local proxies) stay.
    try {
      const u = new URL(override);
      const host = u.hostname.toLowerCase();
      const isTrendyolHost = host.endsWith("trendyol.com") || host.endsWith("tgoapis.com");
      const isApigwHost = host === "apigw.trendyol.com" || host === "stageapigw.trendyol.com";
      if (isTrendyolHost && !isApigwHost) {
        return stripTrailingSlashes(envToIntegrationBaseUrl(env));
      }
      return stripTrailingSlashes(override);
    } catch {
      return stripTrailingSlashes(override);
    }
  }

  // Repo-level env var (root: TRENDYOL_BASE_URL). Accept only apigw.* for Trendyol-owned domains.
  const apigw = process.env.TRENDYOL_BASE_URL?.trim();
  if (apigw) {
    try {
      const u = new URL(apigw);
      const host = u.hostname.toLowerCase();
      const isTrendyolHost = host.endsWith("trendyol.com") || host.endsWith("tgoapis.com");
      const isApigwHost = host === "apigw.trendyol.com" || host === "stageapigw.trendyol.com";
      if (isTrendyolHost && !isApigwHost) {
        return stripTrailingSlashes(envToIntegrationBaseUrl(env));
      }
      return stripTrailingSlashes(apigw);
    } catch {
      // If TRENDYOL_BASE_URL is malformed, ignore it.
    }
  }

  return stripTrailingSlashes(envToIntegrationBaseUrl(env));
}

function extractUpstreamStatusFromErrorMessage(message: string): number | null {
  const msg = String(message || '');
  // trendyolFetch errors usually look like: "Trendyol API call failed (556): ..."
  const m1 = msg.match(/\((\d{3})\)/);
  if (m1) return Number(m1[1]);
  const m2 = msg.match(/\bstatus\s*[:=]\s*(\d{3})\b/i);
  if (m2) return Number(m2[1]);
  return null;
}

function shouldFallbackCommonLabel(status: number | null, message: string): boolean {
  // 556: Trendyol gateway 'Service Unavailable' seen on commonlabel for some carriers
  // also allow transient 502/503/504.
  if (!status) return false;
  return [502, 503, 504, 556].includes(status);
}

async function trendyolFetchWithFallback<T>(
  cfg: TrendyolConfig,
  primaryUrl: string,
  fallbackUrl: string | null,
  options?: Parameters<typeof trendyolFetch>[2],
): Promise<T> {
  try {
    return await trendyolFetch<T>(cfg, primaryUrl, options);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const status = extractUpstreamStatusFromErrorMessage(msg);
    if (fallbackUrl && fallbackUrl !== primaryUrl && shouldFallbackCommonLabel(status, msg)) {
      return await trendyolFetch<T>(cfg, fallbackUrl, options);
    }
    throw e;
  }
}


// Ürün servisleri (product) için dokümantasyondaki “resmi” host apigw.trendyol.com'dur.
// Bazı kurulumlarda cfg.preferSapigw=true ile api.trendyol.com (sapigw) seçilebiliyor.
// Orders tarafında bu bazen işe yarasa da, product create/update gibi uçlarda 400 (bad.request)
// gibi “genel” hatalar görmeye yol açabiliyor. Bu nedenle product endpoint'lerinde apigw'yi
// zorlayarak daha deterministik davranıyoruz.
function resolveProductBaseUrl(cfg: TrendyolConfig): string {
  const env = cfg.env ?? "prod";

  // explicit override (proxy/mocks) still allowed
  const override = cfg.baseUrl?.trim();
  if (override) {
    // If override points to Trendyol's legacy/non-apigw hosts, ignore it for PRODUCT endpoints.
    // Non-Trendyol overrides (local proxies) stay.
    try {
      const u = new URL(override);
      const host = u.hostname.toLowerCase();
      const isTrendyolHost = host.endsWith("trendyol.com") || host.endsWith("tgoapis.com");
      const isApigwHost = host === "apigw.trendyol.com" || host === "stageapigw.trendyol.com";
      if (isTrendyolHost && !isApigwHost) {
        return stripTrailingSlashes(envToIntegrationBaseUrl(env));
      }
      return stripTrailingSlashes(override);
    } catch {
      return stripTrailingSlashes(override);
    }
  }

  // Prefer apigw env var, but guard against misconfiguration.
  const apigw = process.env.TRENDYOL_BASE_URL?.trim();
  if (apigw) {
    try {
      const u = new URL(apigw);
      const host = u.hostname.toLowerCase();
      const isTrendyolHost = host.endsWith("trendyol.com") || host.endsWith("tgoapis.com");
      const isApigwHost = host === "apigw.trendyol.com" || host === "stageapigw.trendyol.com";
      if (isTrendyolHost && !isApigwHost) {
        return stripTrailingSlashes(envToIntegrationBaseUrl(env));
      }
      return stripTrailingSlashes(apigw);
    } catch {
      // ignore malformed TRENDYOL_BASE_URL
    }
  }

  // Fallback to apigw mapping (NOT sapigw)
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

      // Trendyol business/validation errors often come as { timestamp, exception, errors:[...] }.
      // Our previous behavior logged only keys, which is useless for fixing 400s.
      // Here we safely surface a small, non-PII sample of errors to speed up debugging.
      if (Array.isArray(d.errors) && d.errors.length > 0) {
        const keys = Object.keys(d).slice(0, 20);
        const pickError = (e: any) => {
          if (!e || typeof e !== "object") return e;
          const out: any = {};
          for (const k of [
            "errorCode",
            "code",
            "key",
            "field",
            "message",
            "description",
            "reason",
            "detail",
          ]) {
            if (e[k] != null) out[k] = e[k];
          }
          return Object.keys(out).length > 0 ? out : e;
        };

        const errorsSample = d.errors.slice(0, 3).map(pickError);
        const s = JSON.stringify({ keys, errorsCount: d.errors.length, errorsSample });
        return s.length > max ? s.slice(0, max) + "…" : s;
      }

      // Some Trendyol endpoints return business errors as a single { message: "..." } object.
      // Our old behaviour returned only keys (e.g. {"keys":["message"]}), which is useless.
      // Surface the message text safely (still truncated) so Sprint 11.1 can be debugged deterministically.
      const msg =
        (typeof d.message === "string" && d.message.trim())
          ? d.message
          : (typeof d.errorMessage === "string" && d.errorMessage.trim())
            ? d.errorMessage
            : (typeof d.error_description === "string" && d.error_description.trim())
              ? d.error_description
              : (typeof d.detail === "string" && d.detail.trim())
                ? d.detail
                : null;

      if (msg) {
        const s = JSON.stringify({ message: msg });
        return s.length > max ? s.slice(0, max) + "…" : s;
      }

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
  // IMPORTANT: this helper is used by multiple sprints (webhook + seller ops + others).
  // Keep the message generic.
  throw new Error(`Trendyol ${method} ${url} failed (${res.status}) :: ${snippet(res.data)}`);
}


export type OrdersQuery = {
  status?: string | null;
  page?: number;
  size?: number;
  startDate?: number;
  endDate?: number;
  orderByField?: string;
  orderByDirection?: "ASC" | "DESC";
};

export async function trendyolGetOrders(cfg: TrendyolConfig, q: OrdersQuery) {

  // NOTE:
  // - Backward compatible behaviour: if q.status is undefined -> default to "Created" (old behaviour)
  // - If q.status is null/empty string -> omit the status param (some seller accounts may require this)
  const statusParam = (() => {
    if (q.status === undefined) return "Created";
    const s = String(q.status ?? "").trim();
    return s.length ? s : undefined;
  })();

  const page = q.page ?? 0;
  const size = q.size ?? 50;

  const startDate = q.startDate;
  const endDate = q.endDate;

  const orderByField = q.orderByField ?? "PackageLastModifiedDate";
  const orderByDirection = q.orderByDirection ?? "DESC";

  // Trendyol.pdf: recommended order list is under apigw.trendyol.com
  // e.g. /integration/order/sellers/{sellerId}/orders
  // Some accounts may still accept /suppliers/...; we do a safe fallback for robustness.
  const base = resolveApigwBaseUrl(cfg);

  const sellerUrl = `${base}/integration/order/sellers/${cfg.sellerId}/orders`;
  const supplierUrl = `${base}/integration/order/suppliers/${cfg.sellerId}/orders`;

  const params: Record<string, any> = {
    page,
    size,
    orderByField,
    orderByDirection,
  };

  if (statusParam) params.status = statusParam;
  if (typeof startDate === "number") params.startDate = startDate;
  if (typeof endDate === "number") params.endDate = endDate;

  const resSeller = await httpGetJson<any>(sellerUrl, cfg, params);
  if (resSeller.status >= 200 && resSeller.status < 300) return resSeller.data;

  // Fallback: suppliers route (some older docs/examples use this)
  const resSupplier = await httpGetJson<any>(supplierUrl, cfg, params);
  if (resSupplier.status >= 200 && resSupplier.status < 300) return resSupplier.data;

  // Prefer seller error as primary
  throw new Error(
    `Trendyol orders failed (${resSeller.status}) ${sellerUrl} :: ${snippet(resSeller.data)}`,
  );
}

// Backward-compat: eski isim halen import eden yerler için.
export const trendyolGetShipmentPackages = trendyolGetOrders;

/**
 * Legacy listing endpoint: /shipment-packages
 *
 * Bazı hesaplarda /orders listesi boş/uyumsuz dönebilirken /shipment-packages çalışabiliyor.
 * Bu fonksiyon Sprint 11.1 “candidate discovery” için kullanılır.
 */
export async function trendyolGetShipmentPackagesLegacy(cfg: TrendyolConfig, q: OrdersQuery) {
  const base = resolveApigwBaseUrl(cfg);
  const page = q.page ?? 0;
  const size = q.size ?? 50;

  const params: Record<string, any> = { page, size };
  if (q.status != null && String(q.status).trim().length) params.status = String(q.status).trim();
  if (typeof q.startDate === 'number') params.startDate = q.startDate;
  if (typeof q.endDate === 'number') params.endDate = q.endDate;
  if (q.orderByField) params.orderByField = q.orderByField;
  if (q.orderByDirection) params.orderByDirection = q.orderByDirection;

  const sellerUrl = `${base}/integration/order/sellers/${cfg.sellerId}/shipment-packages`;
  const supplierUrl = `${base}/integration/order/suppliers/${cfg.sellerId}/shipment-packages`;

  const resSeller = await httpGetJson<any>(sellerUrl, cfg, params);
  if (resSeller.status >= 200 && resSeller.status < 300) return resSeller.data;

  const resSupplier = await httpGetJson<any>(supplierUrl, cfg, params);
  if (resSupplier.status >= 200 && resSupplier.status < 300) return resSupplier.data;

  throw new Error(
    `Trendyol shipment-packages failed (${resSeller.status}) ${sellerUrl} :: ${snippet(resSeller.data)}`,
  );
}




// -----------------------------
// Sprint 12 — Claims / Iade (returns)
// -----------------------------

export type ClaimsQuery = {
  claimIds?: Array<string | number> | string;
  claimItemStatus?: string;
  startDate?: number;
  endDate?: number;
  orderNumber?: string;
  page?: number;
  size?: number;
};

export async function trendyolGetClaims(cfg: TrendyolConfig, q: ClaimsQuery = {}) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);
  const url = `${base}/integration/order/sellers/${c.sellerId}/claims`;

  const params: Record<string, any> = {
    page: q.page ?? 0,
    size: q.size ?? 50,
  };

  if (q.claimIds != null) {
    if (Array.isArray(q.claimIds)) params.claimIds = q.claimIds.map(String).join(',');
    else {
      const v = String(q.claimIds).trim();
      if (v) params.claimIds = v;
    }
  }

  if (q.claimItemStatus != null && String(q.claimItemStatus).trim().length) {
    params.claimItemStatus = String(q.claimItemStatus).trim();
  }

  if (typeof q.startDate === 'number') params.startDate = q.startDate;
  if (typeof q.endDate === 'number') params.endDate = q.endDate;

  if (q.orderNumber != null && String(q.orderNumber).trim().length) {
    params.orderNumber = String(q.orderNumber).trim();
  }

  return trendyolFetch<any>(c, url, { params });
}

export type ApproveClaimLineItemsInput = {
  claimId: string | number;
  claimLineItemIdList: Array<string | number>;
  params?: Record<string, any>;
};

export async function trendyolApproveClaimLineItems(cfg: TrendyolConfig, input: ApproveClaimLineItemsInput) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);
  const claimId = encodeURIComponent(String(input.claimId ?? '').trim());
  const url = `${base}/integration/order/sellers/${c.sellerId}/claims/${claimId}/items/approve`;

  const list = (input.claimLineItemIdList ?? []).map((x) => {
    const s = String(x).trim();
    return s;
  }).filter(Boolean);

  if (!list.length) throw new Error('approveClaimLineItems: claimLineItemIdList is empty');

  const body = { claimLineItemIdList: list, params: input.params ?? {} };
  return trendyolFetch<any>(c, url, { method: 'PUT', body });
}

export async function trendyolGetClaimsIssueReasons(cfg: TrendyolConfig) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);
  const url = `${base}/integration/order/claim-issue-reasons`;
  return trendyolFetch<any>(c, url);
}

export async function trendyolGetClaimAudits(cfg: TrendyolConfig, claimItemId: string | number) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);
  const id = encodeURIComponent(String(claimItemId ?? '').trim());
  const url = `${base}/integration/order/sellers/${c.sellerId}/claims/items/${id}/audit`;
  return trendyolFetch<any>(c, url);
}

export type CreateClaimIssueInput = {
  claimId: string | number;
  claimIssueReasonId: number | string;
  claimItemIdList: Array<string | number>;
  description: string;
  file?: { buffer: Buffer; filename: string; contentType: string } | null;
};

/**
 * Sprint 12: Reject flow.
 *
 * Trendyol.pdf rules:
 * - description max 500 chars
 * - some reasons require file (handled at worker/UI layer), connector supports multipart when file is provided
 */
export async function trendyolCreateClaimIssue(cfg: TrendyolConfig, input: CreateClaimIssueInput) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);
  const claimId = encodeURIComponent(String(input.claimId ?? '').trim());
  const url = `${base}/integration/order/sellers/${c.sellerId}/claims/${claimId}/issue`;

  const desc = String(input.description ?? '').trim();
  if (desc.length > 500) {
    throw new Error(`createClaimIssue: description must be <= 500 chars (got ${desc.length})`);
  }

  const itemList = (input.claimItemIdList ?? []).map((x) => String(x).trim()).filter(Boolean);
  if (!itemList.length) throw new Error('createClaimIssue: claimItemIdList is empty');

  const params = {
    claimIssueReasonId: input.claimIssueReasonId,
    claimItemIdList: itemList.join(','),
    description: desc,
  } as Record<string, any>;

  // No file => simple POST with query params
  if (!input.file) {
    return trendyolFetch<any>(c, url, { method: 'POST', params });
  }

  // With file => multipart/form-data body, query params still carried in URL
  const boundary = multipartBoundary();
  const crlf = "\r\n";
  const parts: Buffer[] = [];

  const filename = String(input.file?.filename ?? 'file');
  const contentType = String(input.file?.contentType ?? 'application/octet-stream');
  const fileBuf = Buffer.isBuffer(input.file?.buffer) ? input.file.buffer : Buffer.from([]);

  parts.push(
    Buffer.from(
      `--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}` +
        `Content-Type: ${contentType}${crlf}${crlf}`,
      'utf8',
    ),
  );
  parts.push(fileBuf);
  parts.push(Buffer.from(crlf, 'utf8'));
  parts.push(Buffer.from(`--${boundary}--${crlf}`, 'utf8'));

  const body = Buffer.concat(parts);

  const headers = {
    ...buildHeaders(c),
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(body.length),
  } as Record<string, string>;

  const res = await axios.post(url, body, {
    headers,
    params,
    timeout: typeof c.timeoutMs === 'number' ? c.timeoutMs : undefined,
    validateStatus: () => true,
  });

  if (res.status >= 200 && res.status < 300) return res.data;

  throw new Error(`Trendyol POST ${url} failed (${res.status}) :: ${snippet(res.data)}`);
}

/**
 * Sprint 12 optional: Create claim (only for Approved return requests per Trendyol.pdf)
 */
export async function trendyolCreateClaim(cfg: TrendyolConfig, payload: any) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);
  const url = `${base}/integration/order/sellers/${c.sellerId}/claims/create`;
  return trendyolFetch<any>(c, url, { method: 'POST', body: payload });
}

// -----------------------------
// Sprint 13 — QnA (Questions & Answers)
// -----------------------------

export type QnaQuestionsFilterQuery = {
  /** supplierId is required by Trendyol for list/filter. If omitted, we default to cfg.sellerId. */
  supplierId?: string | number;
  status?: string;
  page?: number;
  size?: number;
  /** epoch millis */
  startDate?: number;
  /** epoch millis */
  endDate?: number;
};

export async function trendyolQnaQuestionsFilter(cfg: TrendyolConfig, q: QnaQuestionsFilterQuery) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);

  const sellerId = encodeURIComponent(String(c.sellerId));
  const url = `${base}/integration/qna/sellers/${sellerId}/questions/filter`;

  const page = typeof q.page === "number" ? q.page : 0;
  const sizeRaw = typeof q.size === "number" ? q.size : 50;
  const size = Math.min(Math.max(sizeRaw, 1), 50);

  const supplierId = String((q.supplierId ?? c.supplierId ?? c.sellerId) as any).trim();

  const params: Record<string, any> = { supplierId, page, size };

  const status = String(q.status ?? "").trim();
  if (status.length) params.status = status;

  // Trendyol.pdf: if start/end not provided, defaults to last 1 week.
  // If provided, window must be <= 2 weeks. We only send them when both are present.
  const hasStart = typeof q.startDate === "number" && Number.isFinite(q.startDate);
  const hasEnd = typeof q.endDate === "number" && Number.isFinite(q.endDate);
  if (hasStart && hasEnd) {
    params.startDate = q.startDate;
    params.endDate = q.endDate;
  }

  return trendyolFetch<any>(c, url, { params });
}

export async function trendyolQnaQuestionById(cfg: TrendyolConfig, questionId: string | number) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);

  const sellerId = encodeURIComponent(String(c.sellerId));
  const id = encodeURIComponent(String(questionId));
  const url = `${base}/integration/qna/sellers/${sellerId}/questions/${id}`;

  return trendyolFetch<any>(c, url);
}

export async function trendyolQnaCreateAnswer(
  cfg: TrendyolConfig,
  questionId: string | number,
  text: string,
) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);

  const sellerId = encodeURIComponent(String(c.sellerId));
  const id = encodeURIComponent(String(questionId));
  const url = `${base}/integration/qna/sellers/${sellerId}/questions/${id}/answers`;

  const body = { text };
  return trendyolFetch<any>(c, url, { method: "POST", body });
}


// -----------------------------
// Sprint 11 — Seller ops (addresses / label / invoice)
// -----------------------------

export async function trendyolGetSuppliersAddresses(cfg: TrendyolConfig) {
  const c = normalizeConfig(cfg);
  // Trendyol.pdf: seller ops are documented under apigw.trendyol.com
  const base = resolveApigwBaseUrl(c);
  const url = `${base}/integration/sellers/${c.sellerId}/addresses`;
  return trendyolFetch(c, url);
}

export async function trendyolCreateCommonLabel(cfg: TrendyolConfig, cargoTrackingNumber: string, payload: any) {
  // Trendyol.pdf: createCommonLabel is documented under apigw.trendyol.com
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);
  const ct = encodeURIComponent(String(cargoTrackingNumber ?? '').trim());
  const url = `${base}/integration/sellers/${c.sellerId}/commonlabel/${ct}`;
  return trendyolFetch(c, url, { method: 'POST', body: payload });
}


export async function trendyolGetCommonLabel(cfg: TrendyolConfig, cargoTrackingNumber: string) {
  // Trendyol.pdf: getCommonLabel is documented under apigw.trendyol.com
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);
  const ct = encodeURIComponent(String(cargoTrackingNumber ?? '').trim());
  const url = `${base}/integration/sellers/${c.sellerId}/commonlabel/${ct}`;
  return trendyolFetch(c, url);
}


export async function trendyolSendInvoiceLink(cfg: TrendyolConfig, body: any) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);
  const url = `${base}/integration/sellers/${c.sellerId}/seller-invoice-links`;
  return trendyolFetch(c, url, { method: 'POST', body });
}

export async function trendyolDeleteInvoiceLink(cfg: TrendyolConfig, body: any) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);
  const url = `${base}/integration/sellers/${c.sellerId}/seller-invoice-links/delete`;
  return trendyolFetch(c, url, { method: 'POST', body });
}

export type SellerInvoiceUploadInput = {
  shipmentPackageId: number;
  invoiceDateTime?: number;
  invoiceNumber?: string;
  file: { buffer: Buffer; filename: string; contentType: string };
};

function multipartBoundary() {
  return `----eci${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

export async function trendyolUploadSellerInvoiceFile(cfg: TrendyolConfig, input: SellerInvoiceUploadInput) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);
  const url = `${base}/integration/sellers/${c.sellerId}/seller-invoice-file`;

  const boundary = multipartBoundary();
  const crlf = "\r\n";

  const parts: Buffer[] = [];
  const addField = (name: string, value: string) => {
    parts.push(
      Buffer.from(
        `--${boundary}${crlf}` +
          `Content-Disposition: form-data; name="${name}"${crlf}${crlf}` +
          `${value}${crlf}`,
        'utf8',
      ),
    );
  };

  addField('shipmentPackageId', String(input.shipmentPackageId));
  if (input.invoiceDateTime != null) addField('invoiceDateTime', String(input.invoiceDateTime));
  if (input.invoiceNumber != null) addField('invoiceNumber', String(input.invoiceNumber));

  const filename = String(input.file?.filename ?? 'invoice.pdf');
  const contentType = String(input.file?.contentType ?? 'application/octet-stream');
  const fileBuf = Buffer.isBuffer(input.file?.buffer) ? input.file.buffer : Buffer.from([]);

  parts.push(
    Buffer.from(
      `--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}` +
        `Content-Type: ${contentType}${crlf}${crlf}`,
      'utf8',
    ),
  );
  parts.push(fileBuf);
  parts.push(Buffer.from(crlf, 'utf8'));

  parts.push(Buffer.from(`--${boundary}--${crlf}`, 'utf8'));

  const body = Buffer.concat(parts);

  const headers = {
    ...buildHeaders(c),
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(body.length),
  } as Record<string, string>;

  const res = await axios.post(url, body, {
    headers,
    timeout: typeof c.timeoutMs === 'number' ? c.timeoutMs : undefined,
    validateStatus: () => true,
  });

  if (res.status >= 200 && res.status < 300) {
    return { status: res.status, data: res.data, url };
  }

  throw new Error(`Trendyol seller-invoice-file failed (${res.status}) ${url} :: ${snippet(res.data)}`);
}

/**
 * Teşhis: Connection test / smoke test için “tek doğru kapı”dan probe.
 * Varsayılan: sadece /orders dener.
 * Debug istersen: cfg.probeLegacy=true yapınca /shipment-packages kök endpoint’ini de ayrıca dener.
 */
export async function trendyolProbeShipmentPackages(cfg: TrendyolConfig) {

  // Connection test / smoke test için: çalışan kapıdan (orders) probe yapıyoruz.
  // /shipment-packages kök endpoint’i bazı hesaplarda 401/403 dönebiliyor; o yüzden sadece debug modda deneriz.
  // Trendyol.pdf: recommended seller order endpoints are under apigw.trendyol.com
  const base = resolveApigwBaseUrl(cfg);

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

// -----------------------------
// Sprint 9 — Product endpoints
// -----------------------------

export type BrandsQuery = { page?: number; size?: number };
export async function trendyolGetBrands(cfg: TrendyolConfig, q?: BrandsQuery) {
  const page = q?.page ?? 0;
  const size = q?.size ?? 1000;

  const base = resolveProductBaseUrl(cfg);
  const url = `${base}/integration/product/brands`;
  return trendyolFetch(cfg, url, { params: { page, size } });
}

export async function trendyolGetCategoryTree(cfg: TrendyolConfig) {
  const base = resolveProductBaseUrl(cfg);
  const url = `${base}/integration/product/product-categories`;
  return trendyolFetch(cfg, url);
}

export async function trendyolGetCategoryAttributes(cfg: TrendyolConfig, categoryId: string) {
  const base = resolveProductBaseUrl(cfg);
  const url = `${base}/integration/product/product-categories/${categoryId}/attributes`;
  return trendyolFetch(cfg, url);
}

export async function trendyolGetCategoryAttributeValues(cfg: TrendyolConfig, categoryId: string, attributeId: string) {
  const base = resolveProductBaseUrl(cfg);
  const url = `${base}/integration/product/product-categories/${categoryId}/attributes/${attributeId}/values`;
  return trendyolFetch(cfg, url);
}

export type ProductsListQuery = { page?: number; size?: number };

export async function trendyolListApprovedProducts(cfg: TrendyolConfig, q?: ProductsListQuery) {
  const page = q?.page ?? 0;
  const size = q?.size ?? 50;

  const base = resolveProductBaseUrl(cfg);
  const url = `${base}/integration/product/sellers/${cfg.sellerId}/products`;
  return trendyolFetch(cfg, url, { params: { page, size } });
}

export async function trendyolListUnapprovedProducts(cfg: TrendyolConfig, q?: ProductsListQuery) {
  const page = q?.page ?? 0;
  const size = q?.size ?? 50;

  const base = resolveProductBaseUrl(cfg);
  const url = `${base}/integration/product/sellers/${cfg.sellerId}/products/unapproved`;
  return trendyolFetch(cfg, url, { params: { page, size } });
}

export async function trendyolGetProductBatchRequestResult(cfg: TrendyolConfig, batchRequestId: string) {
  const base = resolveProductBaseUrl(cfg);
  const url = `${base}/integration/product/sellers/${cfg.sellerId}/products/batch-requests/${batchRequestId}`;
  return trendyolFetch(cfg, url);
}

/**
 * Sprint 9 — Products: create / update (batch)
 *
 * Trendyol, ürün oluşturma ve güncelleme için aynı endpoint'i kullanır:
 *  - POST: create
 *  - PUT : update
 *
 * Her ikisi de response içinde batchRequestId döndürür; sonucu ayrıca batch-requests result endpoint'inden takip edilir.
 */
export async function trendyolCreateProducts(cfg: TrendyolConfig, payload: any) {
  const c = normalizeConfig(cfg);
  const base = resolveProductBaseUrl(c);
  const url = `${base}/integration/product/sellers/${c.sellerId}/products`;
  return trendyolFetch(c, url, { method: "POST", body: payload });
}

export async function trendyolUpdateProducts(cfg: TrendyolConfig, payload: any) {
  const c = normalizeConfig(cfg);
  const base = resolveProductBaseUrl(c);
  const url = `${base}/integration/product/sellers/${c.sellerId}/products`;
  return trendyolFetch(c, url, { method: "PUT", body: payload });
}


export async function trendyolUpdatePriceAndInventory(cfg: TrendyolConfig, payload: any) {
  const c = normalizeConfig(cfg);
  const base = resolveIntegrationBaseUrl(c);
  const url = `${base}/integration/inventory/sellers/${c.sellerId}/products/price-and-inventory`;
  return trendyolFetch(c, url, { method: "POST", body: payload });
}


// -----------------------------
// Sprint 14 — Finance / Mutabakat (CHE)
// -----------------------------

export type FinanceCheQuery = {
  /** Timestamp (milliseconds) */
  startDate: number;
  /** Timestamp (milliseconds) */
  endDate: number;
  /** Trendyol Finance transactionType (single type per request) */
  transactionType: string;
  page?: number;
  size?: number;
};

/**
 * Trendyol Finance (CHE) endpoints are picky about `size`.
 * Field evidence (PROBE 14.0): server rejects sizes other than 500 or 1000.
 * We default to 500 to be safe and allow 1000 explicitly.
 */
function normalizeFinanceSize(v: any, fallback = 500): 500 | 1000 {
  const n = Number(v);
  if (Number.isFinite(n) && Math.trunc(n) === 1000) return 1000;
  if (Number.isFinite(n) && Math.trunc(n) === 500) return 500;
  const fb = Math.trunc(Number(fallback));
  return fb === 1000 ? 1000 : 500;
}

function clampInt(n: any, fallback: number, min: number, max: number) {
  const x = typeof n === "number" && Number.isFinite(n) ? n : Number(fallback);
  return Math.min(Math.max(Math.trunc(x), min), max);
}

export async function trendyolFinanceCheSettlements(cfg: TrendyolConfig, q: FinanceCheQuery) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);

  const sellerId = encodeURIComponent(String(c.sellerId));
  const url = `${base}/integration/finance/che/sellers/${sellerId}/settlements`;

  const page = clampInt(q.page, 0, 0, 999999);
  const size = normalizeFinanceSize(q.size, 500);

  const params: Record<string, any> = {
    startDate: q.startDate,
    endDate: q.endDate,
    transactionType: String(q.transactionType ?? "").trim(),
    page,
    size,
  };

  if (!params.transactionType) throw new Error("finance/settlements: transactionType is required");
  if (!params.startDate || !params.endDate) throw new Error("finance/settlements: startDate and endDate are required");

  return trendyolFetch<any>(c, url, { params });
}

export async function trendyolFinanceCheOtherFinancials(cfg: TrendyolConfig, q: FinanceCheQuery) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);

  const sellerId = encodeURIComponent(String(c.sellerId));
  const url = `${base}/integration/finance/che/sellers/${sellerId}/otherfinancials`;

  const page = clampInt(q.page, 0, 0, 999999);
  const size = normalizeFinanceSize(q.size, 500);

  const params: Record<string, any> = {
    startDate: q.startDate,
    endDate: q.endDate,
    transactionType: String(q.transactionType ?? "").trim(),
    page,
    size,
  };

  if (!params.transactionType) throw new Error("finance/otherfinancials: transactionType is required");
  if (!params.startDate || !params.endDate) throw new Error("finance/otherfinancials: startDate and endDate are required");

  return trendyolFetch<any>(c, url, { params });
}

export async function trendyolFinanceCargoInvoiceItems(
  cfg: TrendyolConfig,
  invoiceSerialNumber: string | number,
  q?: { page?: number; size?: number },
) {
  const c = normalizeConfig(cfg);
  const base = resolveApigwBaseUrl(c);

  const sellerId = encodeURIComponent(String(c.sellerId));
  const serial = encodeURIComponent(String(invoiceSerialNumber));
  const url = `${base}/integration/finance/che/sellers/${sellerId}/cargo-invoice/${serial}/items`;

  const page = clampInt(q?.page, 0, 0, 999999);
  const size = normalizeFinanceSize(q?.size, 500);

  const params: Record<string, any> = { page, size };
  return trendyolFetch<any>(c, url, { params });
}



export function normalizeConfig(cfg: TrendyolConfig): TrendyolConfig {
  const sellerId = String(cfg.sellerId ?? "").trim();
  const supplierId = cfg.supplierId != null ? String(cfg.supplierId).trim() : undefined;
  const tokenRaw = cfg.token != null ? String(cfg.token).trim() : undefined;
  const apiKey = cfg.apiKey != null ? String(cfg.apiKey).trim() : undefined;
  const apiSecret = cfg.apiSecret != null ? String(cfg.apiSecret).trim() : undefined;

  const baseUrl = cfg.baseUrl != null ? String(cfg.baseUrl).trim() : undefined;
  const timeoutMs =
    typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : undefined;

  const env = (cfg.env ?? "prod") as TrendyolEnv;

  const agentName = cfg.agentName != null ? String(cfg.agentName).trim() : undefined;
  const integrationName = cfg.integrationName != null ? String(cfg.integrationName).trim() : undefined;

  const preferSapigw = !!cfg.preferSapigw;
  const probeLegacy = !!cfg.probeLegacy;

  return {
    sellerId,
    supplierId: supplierId || undefined,
    env,
    baseUrl: baseUrl || undefined,
    timeoutMs,
    token: tokenRaw,
    apiKey,
    apiSecret,
    agentName,
    integrationName,
    preferSapigw,
    probeLegacy,
  };
}
