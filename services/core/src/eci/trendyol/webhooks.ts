import axios from "axios";
import crypto from "crypto";
import type { TrendyolConfig } from "../connectors/trendyol/client";

/**
 * Sprint 8: Trendyol Webhook client wrappers (PDF uyumlu)
 *
 * Endpoints (PROD):
 *  - POST   https://apigw.trendyol.com/integration/webhook/sellers/{sellerId}/webhooks
 *  - GET    https://apigw.trendyol.com/integration/webhook/sellers/{sellerId}/webhooks
 *  - PUT    https://apigw.trendyol.com/integration/webhook/sellers/{sellerId}/webhooks/{id}
 *  - DELETE https://apigw.trendyol.com/integration/webhook/sellers/{sellerId}/webhooks/{id}
 *  - PUT    https://apigw.trendyol.com/integration/webhook/sellers/{sellerId}/webhooks/{id}/activate
 *  - PUT    https://apigw.trendyol.com/integration/webhook/sellers/{sellerId}/webhooks/{id}/deactivate
 *
 * Not:
 *  - Projede cfg.baseUrl genelde "https://api.trendyol.com/sapigw" olduğu için webhook için
 *    apigw/stageapigw'ye "force" ediyoruz.
 *  - Bu dosya bilinçli olarak connectors/trendyol/client.ts içinde OLMAYAN trendyolFetch'e bağımlı değildir.
 */

export function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export type TrendyolWebhookCreateRequest = {
  url: string;
  authenticationType: "API_KEY" | "BASIC_AUTHENTICATION";
  apiKey?: string;
  username?: string;
  password?: string;
  subscribedStatuses?: string[];
};

function sellerIdOrThrow(cfg: TrendyolConfig) {
  const s = String((cfg as any).sellerId ?? "").trim();
  if (!s) throw new Error("TrendyolConfig.sellerId is required");
  return s;
}

function resolveWebhookBaseOrigin(cfg: TrendyolConfig) {
  // Prefer explicit gateway if baseUrl already points to apigw/stageapigw
  const raw = String((cfg as any).baseUrl ?? "").trim();
  if (raw) {
    try {
      const u = new URL(raw);
      const host = u.host.toLowerCase();
      if (host.includes("stageapigw.trendyol.com")) return "https://stageapigw.trendyol.com";
      if (host.includes("apigw.trendyol.com")) return "https://apigw.trendyol.com";
      // api.trendyol.com/sapigw -> webhook apigw
    } catch {
      // ignore
    }
  }

  const env = String((cfg as any).env ?? "").toLowerCase();
  if (env === "stage") return "https://stageapigw.trendyol.com";
  return "https://apigw.trendyol.com";
}

function basicToken(cfg: TrendyolConfig) {
  const tokenRaw = (cfg as any).token != null ? String((cfg as any).token).trim() : "";
  if (tokenRaw) {
    // server.sprint8 normalizeConfig already strips "Basic "
    return tokenRaw.replace(/^Basic\s+/i, "").trim();
  }
  const apiKey = String((cfg as any).apiKey ?? "").trim();
  const apiSecret = String((cfg as any).apiSecret ?? "").trim();
  if (!apiKey || !apiSecret) throw new Error("TrendyolConfig.apiKey/apiSecret missing for Basic auth");
  return Buffer.from(`${apiKey}:${apiSecret}`, "utf8").toString("base64");
}

function headers(cfg: TrendyolConfig) {
  const sid = sellerIdOrThrow(cfg);
  const agentName = String((cfg as any).agentName ?? "SoXYZ").trim();
  const integrationName = String((cfg as any).integrationName ?? "SoXYZ-ECI").trim();

  return {
    Authorization: `Basic ${basicToken(cfg)}`,
    "x-agentname": agentName,
    "User-Agent": `${sid} - ${integrationName}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function webhookUrl(cfg: TrendyolConfig, suffix: string) {
  const base = resolveWebhookBaseOrigin(cfg).replace(/\/+$/, "");
  const sid = sellerIdOrThrow(cfg);
  const sfx = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${base}/integration/webhook/sellers/${sid}/webhooks${suffix ? sfx : ""}`;
}

async function http(cfg: TrendyolConfig, method: "GET" | "POST" | "PUT" | "DELETE", suffix: string, body?: any) {
  const url = webhookUrl(cfg, suffix);
  const res = await axios.request({
    url,
    method,
    headers: headers(cfg),
    data: body,
    timeout: typeof (cfg as any).timeoutMs === "number" ? (cfg as any).timeoutMs : undefined,
    validateStatus: () => true, // 4xx/5xx kontrolü bizde
  });

  if (res.status < 200 || res.status >= 300) {
    const err: any = new Error(`trendyol webhook ${method} ${url} failed (${res.status})`);
    err.status = res.status;
    err.data = res.data;
    throw err;
  }
  return res.data;
}

export async function trendyolWebhookList(cfg: TrendyolConfig): Promise<any> {
  return http(cfg, "GET", "");
}

export async function trendyolWebhookCreate(cfg: TrendyolConfig, body: TrendyolWebhookCreateRequest): Promise<any> {
  return http(cfg, "POST", "", body);
}

export async function trendyolWebhookUpdate(cfg: TrendyolConfig, webhookId: string, body: Partial<TrendyolWebhookCreateRequest>): Promise<any> {
  return http(cfg, "PUT", `/${encodeURIComponent(webhookId)}`, body);
}

export async function trendyolWebhookActivate(cfg: TrendyolConfig, webhookId: string): Promise<any> {
  return http(cfg, "PUT", `/${encodeURIComponent(webhookId)}/activate`, {});
}

export async function trendyolWebhookDeactivate(cfg: TrendyolConfig, webhookId: string): Promise<any> {
  return http(cfg, "PUT", `/${encodeURIComponent(webhookId)}/deactivate`, {});
}

export async function trendyolWebhookDelete(cfg: TrendyolConfig, webhookId: string): Promise<any> {
  return http(cfg, "DELETE", `/${encodeURIComponent(webhookId)}`, undefined);
}
