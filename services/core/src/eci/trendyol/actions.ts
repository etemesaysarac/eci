/* Sprint 7 — Trendyol order action callers
 * Only edit ACTION_PATHS if your PDF uses different paths.
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
  updateTrackingNumber: "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}/update-tracking-number",
  // PDF: "Kargo sağlayıcı değiştirme"  => .../{packageId}/cargo-providers (PUT)
  changeCargoProvider:  "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}/cargo-providers",

  // PDF: "Sipariş paketi bölme" => .../{packageId}/split (POST) OR .../{packageId}/multi-split (POST)
  splitShipmentPackage: "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}/split",
  multiSplitShipmentPackage:
    "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}/multi-split",

  // PDF: "Kutu bilgisi güncelleme" => .../{packageId}/box-info (PUT)
  updateBoxInfo:        "integration/order/sellers/{sellerId}/shipment-packages/{shipmentPackageId}/box-info",
};

function authHeader(apiKey: string, apiSecret: string) {
  const basic = Buffer.from(`${apiKey}:${apiSecret}`, "ascii").toString("base64");
  return `Basic ${basic}`;
}

async function requestJson(method: "POST" | "PUT", url: string, cfg: TrendyolConfig, body: any) {
  let res = await fetch(url, {
    method,
    headers: {
      "Authorization": authHeader(cfg.apiKey, cfg.apiSecret),
      "User-Agent": cfg.userAgent || `${cfg.sellerId} - ECI`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });


  // ECI_FALLBACK: if sellers path returns 401, try suppliers once
  if (res.status === 401 && url.includes("/integration/order/sellers/")) {
    try {
      const url2 = url.replace("/integration/order/sellers/", "/integration/order/suppliers/");
      res = await fetch(url2, {
        method,
        headers: {
          "Authorization": authHeader(cfg.apiKey, cfg.apiSecret),
          "User-Agent": cfg.userAgent || `${cfg.sellerId} - ECI`,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-ECI-Fallback": "sellers->suppliers"
        },
        body: JSON.stringify(body),
      });
    } catch {}
  }

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

function buildUrl(cfg: TrendyolConfig, template: string, payload?: any) {
  let path = template.replace("{sellerId}", encodeURIComponent(cfg.sellerId));
  if (payload && payload.shipmentPackageId) {
    path = path.replace("{shipmentPackageId}", encodeURIComponent(String(payload.shipmentPackageId)));
  }
  return `${cfg.baseUrl.replace(/\/$/, "")}/${path}`;
}

export async function updateTrackingNumber(cfg: TrendyolConfig, payload: ActionPayload) {
  const { shipmentPackageId, ...rest } = payload ?? {};
  return requestJson("POST", buildUrl(cfg, ACTION_PATHS.updateTrackingNumber, payload), cfg, rest);
}

export async function changeCargoProvider(cfg: TrendyolConfig, payload: ActionPayload) {
  const { shipmentPackageId, ...rest } = payload ?? {};
  return requestJson("PUT", buildUrl(cfg, ACTION_PATHS.changeCargoProvider, payload), cfg, rest);
}

export async function splitShipmentPackage(cfg: TrendyolConfig, payload: ActionPayload) {
  const { shipmentPackageId, ...rest } = payload ?? {};
  // Heuristic: if payload contains splitGroups, it's a multi-split; otherwise use classic split.
  const isMulti = Array.isArray((rest as any)?.splitGroups);
  const template = isMulti ? ACTION_PATHS.multiSplitShipmentPackage : ACTION_PATHS.splitShipmentPackage;
  return requestJson("POST", buildUrl(cfg, template, payload), cfg, rest);
}

export async function updateBoxInfo(cfg: TrendyolConfig, payload: ActionPayload) {
  const { shipmentPackageId, ...rest } = payload ?? {};

  // Back-compat: some callers send boxCount; PDF uses boxQuantity.
  if ((rest as any).boxQuantity == null && (rest as any).boxCount != null) {
    (rest as any).boxQuantity = (rest as any).boxCount;
    delete (rest as any).boxCount;
  }

  return requestJson("PUT", buildUrl(cfg, ACTION_PATHS.updateBoxInfo, payload), cfg, rest);
}
