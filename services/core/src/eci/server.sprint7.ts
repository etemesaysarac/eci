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
import {
  updateTrackingNumber,
  changeCargoProvider,
  splitShipmentPackage,
  updateBoxInfo,
  type TrendyolConfig,
} from "./trendyol/actions";

const prisma = new PrismaClient();

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

// If you store creds per connection in DB, replace this loader.
async function buildTrendyolConfig(_connectionId: string): Promise<TrendyolConfig> {
  return {
    baseUrl: process.env.TRENDYOL_BASE_URL || "https://api.trendyol.com/sapigw",
    sellerId: envOrThrow("TRENDYOL_SELLER_ID"),
    apiKey: envOrThrow("TRENDYOL_API_KEY"),
    apiSecret: envOrThrow("TRENDYOL_API_SECRET"),
    userAgent: `${process.env.TRENDYOL_SELLER_ID} - ECI`,
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
        res.status(e?.status || 500).json({ error: "action_failed", detail: e?.body || e?.message || String(e) });
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
        res.status(e?.status || 500).json({ error: "action_failed", detail: e?.body || e?.message || String(e) });
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
        res.status(e?.status || 500).json({ error: "action_failed", detail: e?.body || e?.message || String(e) });
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
        res.status(e?.status || 500).json({ error: "action_failed", detail: e?.body || e?.message || String(e) });
      }
    })
  );
}
