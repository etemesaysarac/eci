/* Sprint 7 — Trendyol order action callers
 * Only edit ACTION_PATHS if your PDF uses different paths.
 */

export type TrendyolConfig = {
  baseUrl: string;          // e.g. https://api.trendyol.com/sapigw
  sellerId: string;         // numeric string
  apiKey: string;
  apiSecret: string;
  userAgent?: string;       // "<sellerId> - <AppName>"
};

type ActionPayload = Record<string, any>;

const ACTION_PATHS = {
  updateTrackingNumber: "integration/order/sellers/{sellerId}/update-tracking-number",
  changeCargoProvider:  "integration/order/sellers/{sellerId}/change-cargo-provider",
  splitShipmentPackage: "integration/order/sellers/{sellerId}/split-shipment-packages",
  updateBoxInfo:        "integration/order/sellers/{sellerId}/update-box-info",
};

function authHeader(apiKey: string, apiSecret: string) {
  const basic = Buffer.from(`${apiKey}:${apiSecret}`, "ascii").toString("base64");
  return `Basic ${basic}`;
}

async function postJson(url: string, cfg: TrendyolConfig, body: any) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": authHeader(cfg.apiKey, cfg.apiSecret),
      "User-Agent": cfg.userAgent || `${cfg.sellerId} - ECI`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const e: any = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    e.body = json ?? text;
    throw e;
  }
  return json ?? { ok: true };
}

function buildUrl(cfg: TrendyolConfig, template: string) {
  const path = template.replace("{sellerId}", encodeURIComponent(cfg.sellerId));
  return `${cfg.baseUrl.replace(/\/$/, "")}/${path}`;
}

export async function updateTrackingNumber(cfg: TrendyolConfig, payload: ActionPayload) {
  return postJson(buildUrl(cfg, ACTION_PATHS.updateTrackingNumber), cfg, payload);
}

export async function changeCargoProvider(cfg: TrendyolConfig, payload: ActionPayload) {
  return postJson(buildUrl(cfg, ACTION_PATHS.changeCargoProvider), cfg, payload);
}

export async function splitShipmentPackage(cfg: TrendyolConfig, payload: ActionPayload) {
  return postJson(buildUrl(cfg, ACTION_PATHS.splitShipmentPackage), cfg, payload);
}

export async function updateBoxInfo(cfg: TrendyolConfig, payload: ActionPayload) {
  return postJson(buildUrl(cfg, ACTION_PATHS.updateBoxInfo), cfg, payload);
}
