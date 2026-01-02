/*
Sprint 7 — Action Routes (ADD-ON)
================================
This file is an ADD-ON module so you can copy/paste into your existing server bootstrap
without overwriting your current server.ts.

Usage:
  import { registerSprint7ActionRoutes } from "./eci/server.sprint7";
  registerSprint7ActionRoutes(app);

Sprint 7.2 additions:
  - updatePackage (Picking / Invoiced) action endpoint proxy
  - unsupplied (items/unsupplied) action endpoint proxy
  - optional refetch enqueue after updatePackage (?refetch=1)
  - mandatory refetch enqueue after unsupplied (per PDF: new packageId created)
*/

import type { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import IORedis from "ioredis";
import { randomUUID } from "crypto";
import { eciQueue } from "./queue";
import { prisma } from "./prisma";
import { decryptJson } from "./lib/crypto";
import { type TrendyolConfig as DbTrendyolConfig } from "./connectors/trendyol/client";
import {
  updateTrackingNumber,
  changeCargoProvider,
  splitShipmentPackage,
  updateBoxInfo,
  updatePackage,
  unsupplied,
  type TrendyolConfig,
} from "./trendyol/actions";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const SYNC_LOCK_TTL_MS = Number(process.env.SYNC_LOCK_TTL_MS ?? 60 * 60 * 1000);
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

function syncLockKey(connectionId: string) {
  return `eci:sync:lock:${connectionId}`;
}

function normalizeDbConfig(cfg: DbTrendyolConfig): DbTrendyolConfig {
  const sellerId = String(cfg.sellerId ?? "").trim();
  const baseUrlRaw = cfg.baseUrl != null ? String(cfg.baseUrl).trim() : undefined;
  const apiKey = cfg.apiKey != null ? String(cfg.apiKey).trim() : undefined;
  const apiSecret = cfg.apiSecret != null ? String(cfg.apiSecret).trim() : undefined;

  return {
    ...cfg,
    sellerId,
    apiKey,
    apiSecret,
    agentName: String(cfg.agentName ?? "SoXYZ").trim(),
    integrationName: String(cfg.integrationName ?? "SoXYZ-ECI").trim(),
    baseUrl: baseUrlRaw ? baseUrlRaw.replace(/\/+$/, "") : undefined,
  };
}

async function buildTrendyolConfig(connectionId: string): Promise<TrendyolConfig> {
  // Multi-user / multi-connection: credentials live in Connection.configEnc
  const conn = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { id: true, status: true, configEnc: true },
  });
  if (!conn) throw Object.assign(new Error(`Connection not found: ${connectionId}`), { status: 404 });
  if (!["active", "enabled"].includes(conn.status)) throw Object.assign(new Error(`Connection not active: ${connectionId}`), { status: 409 });

  const dbCfg = normalizeDbConfig(decryptJson<DbTrendyolConfig>(conn.configEnc));
  if (!dbCfg.apiKey || !dbCfg.apiSecret) {
    throw Object.assign(new Error("Missing apiKey/apiSecret on connection config"), { status: 400 });
  }

  const baseUrl = dbCfg.baseUrl || process.env.TRENDYOL_BASE_URL || "https://apigw.trendyol.com";
  return {
    baseUrl,
    sellerId: dbCfg.sellerId,
    apiKey: dbCfg.apiKey,
    apiSecret: dbCfg.apiSecret,
    userAgent: `${dbCfg.sellerId} - ${dbCfg.integrationName || "SoXYZ-ECI"}`,
  };
}

async function auditAction(params: {
  connectionId: string;
  shipmentPackageId: string;
  actionType: string;
  request: any;
  response?: any;
  status: "success" | "failed";
  error?: string;
}) {
  const { connectionId, shipmentPackageId, actionType, request, response, status, error } = params;
  await prisma.shipmentPackageAction.create({
    data: {
      connectionId,
      shipmentPackageId,
      actionType,
      request,
      response,
      status,
      error,
    },
  });
}

async function enqueueRefetchOrders(connectionId: string) {
  const lockKey = syncLockKey(connectionId);
  const pending = `pending:${randomUUID()}`;
  const acquired = await redis.set(lockKey, pending, "PX", SYNC_LOCK_TTL_MS, "NX");
  if (acquired !== "OK") return { enqueued: false, reason: "sync_in_progress" as const };

  let jobRow: { id: string } | null = null;
  try {
    jobRow = await prisma.job.create({
      data: {
        connectionId,
        type: "TRENDYOL_SYNC_ORDERS",
        status: "queued",
      },
      select: { id: true },
    });

    // lock owner'ı gerçek jobId yapalım (worker release edebilsin)
    await redis.set(lockKey, jobRow.id, "PX", SYNC_LOCK_TTL_MS);

    await eciQueue.add(
      "TRENDYOL_SYNC_ORDERS",
      { jobId: jobRow.id, connectionId, params: null },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      }
    );

    return { enqueued: true, jobId: jobRow.id };
  } catch (e: any) {
    await redis.del(lockKey);
    if (jobRow?.id) {
      await prisma.job.update({
        where: { id: jobRow.id },
        data: { status: "failed", finishedAt: new Date(), error: String(e?.message ?? e) },
      });
    }
    throw e;
  }
}

function actionError(res: Response, e: any) {
  const status = (e?.status as number) || 500;
  return res.status(status).json({
    error: "action_failed",
    status: e?.status,
    url: e?.url,
    headers: e?.headers,
    detail: e?.body ?? e?.message ?? String(e),
  });
}

export function registerSprint7ActionRoutes(app: any) {
  app.post(
    "/v1/connections/:id/shipment-packages/:packageId/actions/update-tracking-number",
    asyncHandler(async (req: Request, res: Response) => {
      const { id: connectionId, packageId } = req.params as any;
      const cfg = await buildTrendyolConfig(connectionId);
      const body = req.body || {};
      try {
        const resp = await updateTrackingNumber(cfg, { ...body, shipmentPackageId: packageId });
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "update-tracking-number",
          request: body,
          response: resp,
          status: "success",
        });
        res.json({ ok: true, response: resp });
      } catch (e: any) {
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "update-tracking-number",
          request: body,
          status: "failed",
          error: e?.message || String(e),
        });
        return actionError(res, e);
      }
    })
  );

  app.post(
    "/v1/connections/:id/shipment-packages/:packageId/actions/change-cargo-provider",
    asyncHandler(async (req: Request, res: Response) => {
      const { id: connectionId, packageId } = req.params as any;
      const cfg = await buildTrendyolConfig(connectionId);
      const body = req.body || {};
      try {
        const resp = await changeCargoProvider(cfg, { ...body, shipmentPackageId: packageId });
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "change-cargo-provider",
          request: body,
          response: resp,
          status: "success",
        });
        res.json({ ok: true, response: resp });
      } catch (e: any) {
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "change-cargo-provider",
          request: body,
          status: "failed",
          error: e?.message || String(e),
        });
        return actionError(res, e);
      }
    })
  );

  app.post(
    "/v1/connections/:id/shipment-packages/:packageId/actions/split",
    asyncHandler(async (req: Request, res: Response) => {
      const { id: connectionId, packageId } = req.params as any;
      const cfg = await buildTrendyolConfig(connectionId);
      const body = req.body || {};
      try {
        const resp = await splitShipmentPackage(cfg, { ...body, shipmentPackageId: packageId });
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "split",
          request: body,
          response: resp,
          status: "success",
        });
        res.json({ ok: true, response: resp });
      } catch (e: any) {
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "split",
          request: body,
          status: "failed",
          error: e?.message || String(e),
        });
        return actionError(res, e);
      }
    })
  );

  app.post(
    "/v1/connections/:id/shipment-packages/:packageId/actions/update-box-info",
    asyncHandler(async (req: Request, res: Response) => {
      const { id: connectionId, packageId } = req.params as any;
      const cfg = await buildTrendyolConfig(connectionId);
      const body = req.body || {};
      try {
        const resp = await updateBoxInfo(cfg, { ...body, shipmentPackageId: packageId });
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "update-box-info",
          request: body,
          response: resp,
          status: "success",
        });
        res.json({ ok: true, response: resp });
      } catch (e: any) {
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "update-box-info",
          request: body,
          status: "failed",
          error: e?.message || String(e),
        });
        return actionError(res, e);
      }
    })
  );

  // Sprint 7.2: updatePackage (Picking / Invoiced)
  app.post(
    "/v1/connections/:id/shipment-packages/:packageId/actions/update-package",
    asyncHandler(async (req: Request, res: Response) => {
      const { id: connectionId, packageId } = req.params as any;
      const cfg = await buildTrendyolConfig(connectionId);
      const body = req.body || {};
      const wantRefetch = String((req.query as any)?.refetch ?? "") === "1";
      try {
        const resp = await updatePackage(cfg, { ...body, shipmentPackageId: packageId });
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "update-package",
          request: body,
          response: resp,
          status: "success",
        });

        let refetch: any = null;
        if (wantRefetch) refetch = await enqueueRefetchOrders(connectionId);

        res.json({ ok: true, response: resp, refetch });
      } catch (e: any) {
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "update-package",
          request: body,
          status: "failed",
          error: e?.message || String(e),
        });
        return actionError(res, e);
      }
    })
  );

  // Sprint 7.2: unsupplied (items/unsupplied) + mandatory refetch enqueue (per PDF)
  app.post(
    "/v1/connections/:id/shipment-packages/:packageId/actions/unsupplied",
    asyncHandler(async (req: Request, res: Response) => {
      const { id: connectionId, packageId } = req.params as any;
      const cfg = await buildTrendyolConfig(connectionId);
      const body = req.body || {};
      try {
        const resp = await unsupplied(cfg, { ...body, shipmentPackageId: packageId });
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "unsupplied",
          request: body,
          response: resp,
          status: "success",
        });

        const refetch = await enqueueRefetchOrders(connectionId);
        res.json({ ok: true, response: resp, refetch, note: "unsupplied sonrası yeni packageId oluşabileceği için refetch zorunlu" });
      } catch (e: any) {
        await auditAction({
          connectionId,
          shipmentPackageId: String(packageId),
          actionType: "unsupplied",
          request: body,
          status: "failed",
          error: e?.message || String(e),
        });
        return actionError(res, e);
      }
    })
  );
}
