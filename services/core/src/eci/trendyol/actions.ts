/* Sprint 7 — Trendyol order action callers
 *
 * PDF (Trendyol Marketplace / Sipariş Entegrasyonu) path'leri:
 *  - updateTrackingNumber: PUT /integration/order/sellers/{sellerId}/shipment-packages/{packageId}/update-tracking-number
 *  - updatePackage:       PUT /integration/order/sellers/{sellerId}/shipment-packages/{packageId}
 *  - unsupplied:          PUT /integration/order/sellers/{sellerId}/shipment-packages/{packageId}/items/unsupplied
 *
 * Not: PROD baseUrl genelde https://apigw.trendyol.com, STAGE baseUrl genelde https://stageapigw.trendyol.com.
 */

export type TrendyolConfig = {
  baseUrl: string;          // e.g. https://apigw.trendyol.com
  sellerId: string;         // numeric string
  apiKey: string;
  apiSecret: string;
  userAgent?: string;       // "<sellerId> - <AppName>"
};

type ActionPayload = Record<string, any>;

const ACTION_PATHS = {
  updateTrackingNumber:
    "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}/update-tracking-number",

  updatePackage:
    "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}",

  unsupplied:
    "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}/items/unsupplied",

  // PDF: "Kargo sağlayıcı değiştirme" => .../{packageId}/cargo-providers (PUT)
  changeCargoProvider:
    "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}/cargo-providers",

  // PDF: "Sipariş paketi bölme" => .../{packageId}/multi-split (POST)
  splitShipmentPackage:
    "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}/multi-split",

  // PDF: "Sipariş paketi miktar bazlı bölme" => .../{packageId}/quantity-split (POST)
  splitShipmentPackageByQuantity:
    "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}/quantity-split",

  // PDF: "Kutu bilgisi güncelleme" => .../{packageId}/box-info (PUT)
  updateBoxInfo:
    "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}/box-info",
} as const;

function authHeader(apiKey: string, apiSecret: string) {
  const basic = Buffer.from(`${apiKey}:${apiSecret}`, "ascii").toString("base64");
  return `Basic ${basic}`;
}

function buildUrl(cfg: TrendyolConfig, template: string, payload?: any) {
  let path = template.replace("{sellerId}", encodeURIComponent(cfg.sellerId));
  if (payload && payload.shipmentPackageId != null) {
    path = path.replace("{shipmentPackageId}", encodeURIComponent(String(payload.shipmentPackageId)));
  }
  return `${cfg.baseUrl.replace(/\/$/, "")}/${path}`;
}

async function doFetch(method: "POST" | "PUT", url: string, cfg: TrendyolConfig, body: any, extraHeaders?: Record<string, string>) {
  return fetch(url, {
    method,
    headers: {
      "Authorization": authHeader(cfg.apiKey, cfg.apiSecret),
      "User-Agent": cfg.userAgent || `${cfg.sellerId} - ECI`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
  });
}

/** Robust JSON requester with small, deterministic fallbacks:
 *  - sellers -> suppliers fallback (401 only)
 *  - shipment-packages -> shipmentpackages fallback (404/405 only) (some older gateway variants)
 */
async function requestJson(method: "POST" | "PUT", url: string, cfg: TrendyolConfig, body: any) {
  // 1) first attempt
  let res = await doFetch(method, url, cfg, body);

  // 2) if 401 on sellers path, try suppliers once
  if (res.status === 401 && url.includes("/integration/order/sellers/")) {
    const url2 = url.replace("/integration/order/sellers/", "/integration/order/suppliers/");
    res = await doFetch(method, url2, cfg, body, { "X-ECI-Fallback": "sellers->suppliers" });
    url = url2;
  }

  // 3) if 404/405 and shipment-packages present, try shipmentpackages variant once
  if ((res.status === 404 || res.status === 405) && url.includes("/shipment-packages/")) {
    const url3 = url.replace("/shipment-packages/", "/shipmentpackages/");
    res = await doFetch(method, url3, cfg, body, { "X-ECI-Fallback": "shipment-packages->shipmentpackages" });
    url = url3;
  }

  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const e: any = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    e.body = json ?? text;
    e.headers = Object.fromEntries(res.headers.entries());
    e.url = url;
    throw e;
  }

  return json ?? { ok: true };
}

export async function updateTrackingNumber(cfg: TrendyolConfig, payload: ActionPayload) {
  const { shipmentPackageId, ...rest } = payload ?? {};
  return requestJson("PUT", buildUrl(cfg, ACTION_PATHS.updateTrackingNumber, payload), cfg, rest);
}

export async function updatePackage(cfg: TrendyolConfig, payload: ActionPayload) {
  const { shipmentPackageId, ...rest } = payload ?? {};
  return requestJson("PUT", buildUrl(cfg, ACTION_PATHS.updatePackage, payload), cfg, rest);
}

export async function unsupplied(cfg: TrendyolConfig, payload: ActionPayload) {
  const { shipmentPackageId, ...rest } = payload ?? {};
  return requestJson("PUT", buildUrl(cfg, ACTION_PATHS.unsupplied, payload), cfg, rest);
}

export async function changeCargoProvider(cfg: TrendyolConfig, payload: ActionPayload) {
  const { shipmentPackageId, ...rest } = payload ?? {};
  return requestJson("PUT", buildUrl(cfg, ACTION_PATHS.changeCargoProvider, payload), cfg, rest);
}

export async function splitShipmentPackage(cfg: TrendyolConfig, payload: ActionPayload) {
  const { shipmentPackageId, ...rest } = payload ?? {};

  const isQuantitySplit =
    rest && typeof rest === "object" && ((rest as any).quantitySplit != null || (rest as any).splitByQuantity != null);

  if ((rest as any).quantitySplit == null && (rest as any).splitByQuantity != null) {
    (rest as any).quantitySplit = (rest as any).splitByQuantity;
    delete (rest as any).splitByQuantity;
  }

  const template = isQuantitySplit ? ACTION_PATHS.splitShipmentPackageByQuantity : ACTION_PATHS.splitShipmentPackage;
  return requestJson("POST", buildUrl(cfg, template, payload), cfg, rest);
}

export async function updateBoxInfo(cfg: TrendyolConfig, payload: ActionPayload) {
  const { shipmentPackageId, ...rest } = payload ?? {};

  if ((rest as any).boxQuantity == null && (rest as any).boxCount != null) {
    (rest as any).boxQuantity = (rest as any).boxCount;
    delete (rest as any).boxCount;
  }

  return requestJson("PUT", buildUrl(cfg, ACTION_PATHS.updateBoxInfo, payload), cfg, rest);
}
