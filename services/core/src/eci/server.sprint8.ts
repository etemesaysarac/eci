import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "./prisma";
import { decryptJson, encryptJson } from "./lib/crypto";
import type { TrendyolConfig } from "./connectors/trendyol/client";
import {
  sha256Hex,
  trendyolWebhookActivate,
  trendyolWebhookCreate,
  trendyolWebhookDeactivate,
  trendyolWebhookDelete,
  trendyolWebhookList,
  type TrendyolWebhookCreateRequest,
} from "./trendyol/webhooks";
import { eciQueue } from "./queue";

/**
 * Sprint 8: Webhook management + receiver
 *
 * Goals:
 * - Enable/disable/list webhooks from our API
 * - Receive webhook events, verify, deduplicate, enqueue targeted sync
 *
 * NOTE:
 * - For local dev you must expose your receiver publicly (ngrok/cloudflared) and set:
 *   ECI_PUBLIC_BASE_URL=https://<public-host>
 * - Signature rules differ by provider; Trendyol webhook docs define the auth headers.
 */

function nowIso() {
  return new Date().toISOString();
}
function log(msg: string, meta?: Record<string, unknown>) {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[eci-api] ${nowIso()} ${msg}${suffix}`);
}

function normalizeConfig(cfg: TrendyolConfig): TrendyolConfig {
  const sellerId = String(cfg.sellerId ?? "").trim();
  const tokenRaw = cfg.token != null ? String(cfg.token).trim() : undefined;
  const apiKey = cfg.apiKey != null ? String(cfg.apiKey).trim() : undefined;
  const apiSecret = cfg.apiSecret != null ? String(cfg.apiSecret).trim() : undefined;
  const baseUrlRaw = cfg.baseUrl != null ? String(cfg.baseUrl).trim() : undefined;

  return {
    ...cfg,
    sellerId,
    token: tokenRaw ? tokenRaw.replace(/^Basic\s+/i, "").trim() : undefined,
    apiKey,
    apiSecret,
    agentName: String(cfg.agentName ?? "SoXYZ").trim(),
    integrationName: String(cfg.integrationName ?? "SoXYZ-ECI").trim(),
    baseUrl: baseUrlRaw ? baseUrlRaw.replace(/\/+$/, "") : undefined,
  };
}

function resolvePublicWebhookUrl() {
  const base = (process.env.ECI_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("ECI_PUBLIC_BASE_URL is required to enable Trendyol webhooks (public receiver URL)");
  }
  return `${base}/v1/webhooks/orders`; // avoid forbidden keywords in URL
}

const EnableSchema = z.object({
  authenticationType: z.enum(["API_KEY", "BASIC_AUTHENTICATION"]).default("API_KEY"),
  subscribedStatuses: z.array(z.string()).optional(),
});

function randomSecret(len = 32) {
  return crypto.randomBytes(len).toString("base64url");
}

async function mustGetTrendyolConnection(connectionId: string) {
  const conn = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { id: true, type: true, name: true, configEnc: true },
  });
  if (!conn) throw new Error("connection not found");
  if (conn.type !== "trendyol") throw new Error(`unsupported connection type: ${conn.type}`);
  const cfg = normalizeConfig(decryptJson<TrendyolConfig>(conn.configEnc));
  return { conn, cfg };
}

function coerceRemoteWebhookId(remote: any): string | null {
  // Try common shapes: { id }, { webhookId }, { data: { id } }, ...
  const candidates = [
    remote?.id,
    remote?.webhookId,
    remote?.data?.id,
    remote?.data?.webhookId,
    remote?.webhook?.id,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== "") return String(c);
  }
  return null;
}

function coerceRemoteListItems(remote: any): any[] {
  if (!remote) return [];
  if (Array.isArray(remote)) return remote;
  if (Array.isArray(remote?.content)) return remote.content;
  if (Array.isArray(remote?.data)) return remote.data;
  if (Array.isArray(remote?.webhooks)) return remote.webhooks;
  return [];
}

function headerLower(req: Request, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v != null ? String(v) : undefined;
}

function sha256BodyHex(buf: Buffer) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickEventKey(provider: string, bodyHash: string, payload: any): string {
  // Trendyol payload may include unique fields (e.g., webhookEventId).
  // If present, prefer it. Otherwise fall back to bodyHash.
  const candidates = [
    payload?.eventId,
    payload?.webhookEventId,
    payload?.id,
    payload?.notificationId,
  ].filter((x) => x != null && String(x).trim() !== "");
  if (candidates.length > 0) return `${provider}:${String(candidates[0])}`;
  return `${provider}:body:${bodyHash}`;
}

async function enqueueTargetedSync(connectionId: string, payload: any) {
  // We store the raw event as a job (audit + retry), then it triggers a targeted sync.
  const jobRow = await prisma.job.create({
    data: {
      connectionId,
      type: "TRENDYOL_WEBHOOK_EVENT",
      status: "queued",
    },
    select: { id: true },
  });

  await eciQueue.add(
    "TRENDYOL_WEBHOOK_EVENT",
    {
      jobId: jobRow.id,
      connectionId,
      webhook: {
        provider: "TRENDYOL",
        payload,
      },
    },
    {
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    }
  );

  return jobRow.id;
}

export function registerSprint8WebhookRoutes(app: Express) {
  // -----------------------------
  // Management endpoints
  // -----------------------------

  app.post("/v1/connections/:id/webhooks/enable", async (req: Request, res: Response) => {
    try {
      const connectionId = req.params.id;
      const parsed = EnableSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const { authenticationType, subscribedStatuses } = parsed.data;
      const statusesUpper = subscribedStatuses?.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
      const { cfg } = await mustGetTrendyolConnection(connectionId);

      const endpointUrl = resolvePublicWebhookUrl();

      log("webhook enable requested", { connectionId, endpointUrl, authenticationType });

      // Find or create local subscription (connectionId+provider unique)
      let sub = await prisma.webhookSubscription.findUnique({
        where: { connectionId_provider: { connectionId, provider: "TRENDYOL" } },
      });

      let secrets: any;
      if (!sub) {
        if (authenticationType === "API_KEY") {
          const apiKey = randomSecret(24);
          secrets = { apiKey };
          sub = await prisma.webhookSubscription.create({
            data: {
              connectionId,
              provider: "TRENDYOL",
              status: "PASSIVE",
              endpointUrl,
              authenticationType,
              apiKeyHash: sha256Hex(apiKey),
              secretsEnc: encryptJson(secrets),
              subscribedStatuses: statusesUpper ? statusesUpper : undefined,
            },
          });
        } else {
          const username = `eci_${connectionId.slice(0, 8)}`;
          const password = randomSecret(24);
          secrets = { username, password };
          sub = await prisma.webhookSubscription.create({
            data: {
              connectionId,
              provider: "TRENDYOL",
              status: "PASSIVE",
              endpointUrl,
              authenticationType,
              basicUsername: username,
              basicPasswordHash: sha256Hex(password),
              secretsEnc: encryptJson(secrets),
              subscribedStatuses: statusesUpper ? statusesUpper : undefined,
            },
          });
        }
      } else {
        // Load secrets to return them on enable (so user can configure Trendyol webhook if needed)
        secrets = sub.secretsEnc ? decryptJson<any>(sub.secretsEnc) : null;
      }

      // Remote: create or activate
      let remoteWebhookId = sub.remoteWebhookId ?? null;

      try {
      if (!remoteWebhookId) {
        const secretsPlain = sub.secretsEnc ? decryptJson<any>(sub.secretsEnc) : {};
        const createReq: TrendyolWebhookCreateRequest =
          sub.authenticationType === "API_KEY"
            ? {
                url: endpointUrl,
                authenticationType: "API_KEY",
                apiKey: String(secretsPlain?.apiKey ?? ""),
                subscribedStatuses: statusesUpper ?? undefined,
              }
            : {
                url: endpointUrl,
                authenticationType: "BASIC_AUTHENTICATION",
                username: String(secretsPlain?.username ?? sub.basicUsername ?? ""),
                password: String(secretsPlain?.password ?? ""),
                subscribedStatuses: statusesUpper ?? undefined,
              };

        const remote = await trendyolWebhookCreate(cfg, createReq);
        remoteWebhookId = coerceRemoteWebhookId(remote);
        if (!remoteWebhookId) {
          // Not fatal, but without id we can't activate/deactivate later.
          log("webhook create returned no id", { connectionId, remote });
        }
      } else {
        await trendyolWebhookActivate(cfg, remoteWebhookId);
      }

      // Ensure active
      if (remoteWebhookId) {
        await trendyolWebhookActivate(cfg, remoteWebhookId);
      }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        log("webhook remote enable failed", { connectionId, endpointUrl, error: msg });

        return res.status(502).json({
          ok: false,
          stage: remoteWebhookId ? "activate" : "create",
          endpointUrl,
          subscription: {
            id: sub.id,
            provider: sub.provider,
            status: sub.status,
            remoteWebhookId: sub.remoteWebhookId,
            authenticationType: sub.authenticationType,
          },
          secrets: secrets ?? null,
          error: msg,
          hint:
            "Public URL must be reachable. Verify: curl -I <ECI_PUBLIC_BASE_URL>/v1/webhooks/orders should return 200, and ECI_PUBLIC_BASE_URL must be the PUBLIC host (no /v1 path, no trailing slash).",
        });
      }

      const updated = await prisma.webhookSubscription.update({
        where: { id: sub.id },
        data: {
          endpointUrl,
          status: "ACTIVE",
          remoteWebhookId: remoteWebhookId ?? undefined,
          subscribedStatuses: statusesUpper ? statusesUpper : sub.subscribedStatuses,
        },
      });

      return res.json({
        ok: true,
        subscription: {
          id: updated.id,
          provider: updated.provider,
          status: updated.status,
          remoteWebhookId: updated.remoteWebhookId,
          endpointUrl: updated.endpointUrl,
          authenticationType: updated.authenticationType,
        },
        secrets: secrets ?? null,
        note:
          "Receiver expects auth headers. For API_KEY: Trendyol uses the Authorization header (we also accept 'x-api-key' for manual tests). For BASIC: send HTTP Basic auth header.",
      });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  app.post("/v1/connections/:id/webhooks/disable", async (req: Request, res: Response) => {
    try {
      const connectionId = req.params.id;
      const { cfg } = await mustGetTrendyolConnection(connectionId);

      const sub = await prisma.webhookSubscription.findUnique({
        where: { connectionId_provider: { connectionId, provider: "TRENDYOL" } },
      });
      if (!sub) return res.status(404).json({ error: "subscription_not_found" });

      if (sub.remoteWebhookId) {
        await trendyolWebhookDeactivate(cfg, sub.remoteWebhookId);
      }

      const updated = await prisma.webhookSubscription.update({
        where: { id: sub.id },
        data: { status: "PASSIVE" },
      });

      return res.json({ ok: true, subscription: { id: updated.id, status: updated.status, remoteWebhookId: updated.remoteWebhookId } });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  app.get("/v1/connections/:id/webhooks", async (req: Request, res: Response) => {
    try {
      const connectionId = req.params.id;
      const { cfg } = await mustGetTrendyolConnection(connectionId);

      const local = await prisma.webhookSubscription.findUnique({
        where: { connectionId_provider: { connectionId, provider: "TRENDYOL" } },
        select: {
          id: true,
          provider: true,
          status: true,
          remoteWebhookId: true,
          endpointUrl: true,
          authenticationType: true,
          subscribedStatuses: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      let remote: any = null;
      try {
        remote = await trendyolWebhookList(cfg);
      } catch (e: any) {
        remote = { error: String(e?.message ?? e) };
      }

      return res.json({ local, remote });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // Optional: destructive (kept for manual ops / debug)
  app.delete("/v1/connections/:id/webhooks", async (req: Request, res: Response) => {
    try {
      const connectionId = req.params.id;
      const { cfg } = await mustGetTrendyolConnection(connectionId);

      const sub = await prisma.webhookSubscription.findUnique({
        where: { connectionId_provider: { connectionId, provider: "TRENDYOL" } },
      });
      if (!sub) return res.status(404).json({ error: "subscription_not_found" });

      if (sub.remoteWebhookId) {
        await trendyolWebhookDelete(cfg, sub.remoteWebhookId);
      }
      await prisma.webhookSubscription.delete({ where: { id: sub.id } });

      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // -----------------------------
  // Receiver endpoint
  // -----------------------------

  const webhookHandler = async (req: Request, res: Response) => {
    const raw = (req as any).rawBody as Buffer | undefined;
    const rawBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
    const rawText = rawBuf.toString("utf8");
    const bodyHash = sha256BodyHex(rawBuf);

    const apiKeyHeader = headerLower(req, "x-api-key");
    const auth = headerLower(req, "authorization");

    // Trendyol's API_KEY webhook auth is sent via the Authorization header.
    // We support both:
    // - Authorization: <apiKey>
    // - Authorization: ApiKey <apiKey>
    // - x-api-key: <apiKey> (useful for manual tests)
    let apiKey: string | undefined = apiKeyHeader;
    if (!apiKey && auth && !auth.toLowerCase().startsWith("basic ")) {
      apiKey = auth
        .replace(/^apikey\s+/i, "")
        .replace(/^bearer\s+/i, "")
        .trim();
      if (!apiKey) apiKey = undefined;
    }

    try {
      // Find subscription by credential (apiKeyHash or basic username)
      let sub: any = null;

      if (apiKey) {
        sub = await prisma.webhookSubscription.findFirst({
          where: { provider: "TRENDYOL", apiKeyHash: sha256Hex(apiKey) },
        });
      } else if (auth && auth.toLowerCase().startsWith("basic ")) {
        const token = auth.slice(6).trim();
        const decoded = Buffer.from(token, "base64").toString("utf8");
        const idx = decoded.indexOf(":");
        const username = idx >= 0 ? decoded.slice(0, idx) : decoded;
        const password = idx >= 0 ? decoded.slice(idx + 1) : "";
        sub = await prisma.webhookSubscription.findFirst({
          where: { provider: "TRENDYOL", basicUsername: username, basicPasswordHash: sha256Hex(password) },
        });
      }

      if (!sub) {
        // Unknown credential => 401 (do not leak info)
        log("webhook unauthorized", { bodyHash, hasApiKey: !!apiKey, hasAuth: !!auth });
        return res.status(401).json({ ok: false });
      }

      const connectionId = sub.connectionId;

      const payloadJson = safeJsonParse(rawText) ?? req.body ?? null;
      const provider = "TRENDYOL";
      const eventKey = pickEventKey(provider, bodyHash, payloadJson);

      // Insert event (dedup by eventKey unique)
      let eventRow: any;
      try {
        eventRow = await prisma.webhookEvent.create({
          data: {
            connectionId,
            subscriptionId: sub.id,
            provider,
            eventKey,
            bodyHash,
            headers: req.headers as any,
            rawBody: payloadJson as any,
            rawBodyText: rawText,
            verifyStatus: "ok",
            dedupHit: false,
          },
          select: { id: true, eventKey: true },
        });
      } catch (e: any) {
        // Unique violation => dedup hit
        const msg = String(e?.message ?? e);
        if (msg.includes("Unique constraint") || msg.includes("WebhookEvent_eventKey_key") || msg.includes("eventKey")) {
          await prisma.webhookEvent.updateMany({
            where: { eventKey },
            data: { dedupHit: true },
          });
          return res.status(200).json({ ok: true, dedup: true });
        }
        // Unexpected insert failure
        log("webhookEvent insert failed", { error: msg, eventKey });
        return res.status(500).json({ ok: false });
      }

      // Enqueue targeted sync (idempotent because dedup prevents re-enqueue)
      const jobId = await enqueueTargetedSync(connectionId, payloadJson);

      log("webhook accepted", { connectionId, eventKey, jobId });

      return res.status(200).json({ ok: true, dedup: false, eventKey, jobId });
    } catch (e: any) {
      log("webhook handler error", { error: String(e?.message ?? e), bodyHash });
      return res.status(500).json({ ok: false });
    }
  };

  // Real callback endpoint (neutral path for Trendyol URL validation)
  app.post("/v1/webhooks/orders", webhookHandler);

  // Backward compatible/testing endpoint (do NOT use for Trendyol subscription)
  app.post("/v1/webhooks/trendyol", webhookHandler);

}
