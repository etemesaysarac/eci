/*
Sprint 7 — Action Routes (ADD-ON)
================================
This file is an ADD-ON module so you can copy/paste into your existing server bootstrap
without overwriting your current server.ts.

Usage:
  import { registerSprint7ActionRoutes } from "./eci/server.sprint7";
  registerSprint7ActionRoutes(app);
*/

import type { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import { PrismaClient } from "@prisma/client";
import { decryptJson } from "./lib/crypto";
import { type TrendyolConfig as DbTrendyolConfig } from "./connectors/trendyol/client";
import {
  updateTrackingNumber,
  changeCargoProvider,
  splitShipmentPackage,
  updateBoxInfo,
  type TrendyolConfig,
} from "./trendyol/actions";

const prisma = new PrismaClient();

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
  if (conn.status !== "active") throw Object.assign(new Error(`Connection not active: ${connectionId}`), { status: 409 });

  const dbCfg = normalizeDbConfig(decryptJson<DbTrendyolConfig>(conn.configEnc));
  if (!dbCfg.apiKey || !dbCfg.apiSecret) {
    throw Object.assign(new Error("Missing apiKey/apiSecret on connection config"), { status: 400 });
  }

  // Action caller expects explicit baseUrl/sellerId/apiKey/apiSecret + userAgent
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

export function registerSprint7ActionRoutes(app: any) {
  app.post("/v1/connections/:id/shipment-packages/:packageId/actions/update-tracking-number",
    asyncHandler(async (req: Request, res: Response) => {
      const { id: connectionId, packageId } = req.params as any;
      const cfg = await buildTrendyolConfig(connectionId);
      const body = req.body || {};
      try {
        const resp = await updateTrackingNumber(cfg, { ...body, shipmentPackageId: packageId });
        await auditAction({ connectionId, shipmentPackageId: String(packageId), actionType: "update-tracking-number", request: body, response: resp, status: "success" });
        res.json({ ok: true, response: resp });
      } catch (e: any) {
        await auditAction({ connectionId, shipmentPackageId: String(packageId), actionType: "update-tracking-number", request: body, status: "failed", error: e?.message || String(e) });
        res.status((e?.status as any) || 500).json({ error: "action_failed", status: e?.status, headers: e?.headers, detail: (e?.body ?? e?.message ?? String(e)) });
      }
    })
  );

  app.post("/v1/connections/:id/shipment-packages/:packageId/actions/change-cargo-provider",
    asyncHandler(async (req: Request, res: Response) => {
      const { id: connectionId, packageId } = req.params as any;
      const cfg = await buildTrendyolConfig(connectionId);
      const body = req.body || {};
      try {
        const resp = await changeCargoProvider(cfg, { ...body, shipmentPackageId: packageId });
        await auditAction({ connectionId, shipmentPackageId: String(packageId), actionType: "change-cargo-provider", request: body, response: resp, status: "success" });
        res.json({ ok: true, response: resp });
      } catch (e: any) {
        await auditAction({ connectionId, shipmentPackageId: String(packageId), actionType: "change-cargo-provider", request: body, status: "failed", error: e?.message || String(e) });
        res.status((e?.status as any) || 500).json({ error: "action_failed", status: e?.status, headers: e?.headers, detail: (e?.body ?? e?.message ?? String(e)) });
      }
    })
  );

  app.post("/v1/connections/:id/shipment-packages/:packageId/actions/split",
    asyncHandler(async (req: Request, res: Response) => {
      const { id: connectionId, packageId } = req.params as any;
      const cfg = await buildTrendyolConfig(connectionId);
      const body = req.body || {};
      try {
        const resp = await splitShipmentPackage(cfg, { ...body, shipmentPackageId: packageId });
        await auditAction({ connectionId, shipmentPackageId: String(packageId), actionType: "split", request: body, response: resp, status: "success" });
        res.json({ ok: true, response: resp });
      } catch (e: any) {
        await auditAction({ connectionId, shipmentPackageId: String(packageId), actionType: "split", request: body, status: "failed", error: e?.message || String(e) });
        res.status((e?.status as any) || 500).json({ error: "action_failed", status: e?.status, headers: e?.headers, detail: (e?.body ?? e?.message ?? String(e)) });
      }
    })
  );

  app.post("/v1/connections/:id/shipment-packages/:packageId/actions/update-box-info",
    asyncHandler(async (req: Request, res: Response) => {
      const { id: connectionId, packageId } = req.params as any;
      const cfg = await buildTrendyolConfig(connectionId);
      const body = req.body || {};
      try {
        const resp = await updateBoxInfo(cfg, { ...body, shipmentPackageId: packageId });
        await auditAction({ connectionId, shipmentPackageId: String(packageId), actionType: "update-box-info", request: body, response: resp, status: "success" });
        res.json({ ok: true, response: resp });
      } catch (e: any) {
        await auditAction({ connectionId, shipmentPackageId: String(packageId), actionType: "update-box-info", request: body, status: "failed", error: e?.message || String(e) });
        res.status((e?.status as any) || 500).json({ error: "action_failed", status: e?.status, headers: e?.headers, detail: (e?.body ?? e?.message ?? String(e)) });
      }
    })
  );
}
