/*
Sprint 11 — Fatura Linki / Seller Invoice / Label
===============================================

Trendyol.pdf (satıcı operasyonları) referansı:
- getSuppliersAddresses: GET /integration/sellers/{sellerId}/addresses
- createCommonLabel:     POST /integration/sellers/{sellerId}/commonlabel/{cargoTrackingNumber}
- getCommonLabel:        GET  /integration/sellers/{sellerId}/commonlabel/{cargoTrackingNumber}
- sendInvoiceLink:       POST /integration/sellers/{sellerId}/seller-invoice-links
- deleteInvoiceLink:     POST /integration/sellers/{sellerId}/seller-invoice-links/delete
- sellerInvoiceFile:     POST /integration/sellers/{sellerId}/seller-invoice-file (multipart)

ECI Sprint 11 hedefi:
- Panelin “kargo etiketi yazdır” (ZPL) ve “fatura” akışını gerçekçi hale getirmek.
- Şimdilik storage: LOCAL (repoRoot/outputs/sprint11/...). MinIO/S3 sonraki iterasyonda.
- Write endpoint'lerinde dryRun=1 seçeneği: önce kanıt üret, sonra gerçek yaz.
*/

import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import { prisma } from "./prisma";
import { decryptJson } from "./lib/crypto";

import type { TrendyolConfig } from "./connectors/trendyol/client";
import {
  trendyolGetOrders,
  trendyolGetShipmentPackagesLegacy,
  trendyolGetSuppliersAddresses,
  trendyolCreateCommonLabel,
  trendyolGetCommonLabel,
  trendyolSendInvoiceLink,
  trendyolDeleteInvoiceLink,
  trendyolUploadSellerInvoiceFile,
} from "./connectors/trendyol/client";

import { updatePackage as trendyolUpdatePackage } from "./trendyol/actions";

// Express 4/5 does NOT automatically catch async errors.
const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any> | any) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

function parseBool(v: unknown): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function parseUpstreamStatusFromErrorMessage(msg: string): number | null {
  const m = String(msg ?? "").match(/\((\d{3})\)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractUpdatePackageLines(order: any): Array<{ lineId: number; quantity: number }> {
  const raw = (order && (order.lines ?? order.orderLines ?? order.items ?? order.orderItems)) ?? [];
  const arr = Array.isArray(raw) ? raw : [];
  const out: Array<{ lineId: number; quantity: number }> = [];
  for (const l of arr) {
    const id = Number((l as any)?.lineId ?? (l as any)?.id ?? (l as any)?.orderLineId ?? (l as any)?.orderLineNumber);
    const qty = Number((l as any)?.quantity ?? (l as any)?.qty ?? (l as any)?.amount);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out.push({ lineId: id, quantity: qty });
  }
  return out;
}

function dateStampCompact(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// Trendyol.pdf (invoice/link) invoiceNumber format:
//   [3 alphanumeric][13 numeric]  => total 16
//   digits 4-7 are year (2020-2099), last 9 digits are numeric sequence.
// We generate a deterministic default from shipmentPackageId to avoid "placeholder" usage.
function makeInvoiceNumberFromPackageId(shipmentPackageId: string, prefix = "ECI", now = new Date()): string {
  const p = String(prefix ?? "ECI")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .padEnd(3, "X")
    .slice(0, 3);
  const year = String(now.getFullYear());
  const digits = String(shipmentPackageId ?? "").replace(/\D/g, "");
  const seq9 = (digits.length >= 9 ? digits.slice(-9) : digits.padStart(9, "0"));
  return `${p}${year}${seq9}`;
}

function isValidInvoiceNumber(v: string): boolean {
  const s = String(v ?? "").trim();
  if (!/^[A-Za-z0-9]{3}[0-9]{13}$/.test(s)) return false;
  const year = Number(s.slice(3, 7));
  return year >= 2020 && year <= 2099;
}

function normalizeInvoiceNumber(v: unknown, shipmentPackageId: string): string {
  const raw = String(v ?? "").trim();
  if (raw && isValidInvoiceNumber(raw)) return raw;
  return makeInvoiceNumberFromPackageId(shipmentPackageId);
}

// Trendyol.pdf examples typically show invoiceDateTime as UNIX seconds (10 digits).
// We accept ms (13 digits) and normalize to seconds.
function normalizeInvoiceDateTimeSeconds(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000);
  // if it's milliseconds, convert to seconds
  if (n > 10_000_000_000) return Math.floor(n / 1000);
  return Math.floor(n);
}

function normalizeBaseUrl(input: unknown): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  return s.replace(/\/+$/, "");
}

function getPublicBaseUrl(req: Request): string {
  const env = normalizeBaseUrl(process.env.ECI_PUBLIC_BASE_URL);
  if (env) return env;
  return `${req.protocol}://${req.get("host")}`;
}

function safePathSegment(input: unknown, label: string): string {
  const s = String(input ?? "").trim();
  if (!s) throw new Error(`missing_${label}`);
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned.includes("..")) throw new Error(`invalid_${label}`);
  return cleaned;
}

function safePositiveInt(input: unknown, label: string): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid_${label}`);
  return Math.floor(n);
}

async function resolveCustomerIdForShipmentPackage(cfg: any, shipmentPackageId: number, lookbackDays = 90) {
  // Trendyol.pdf: customerId is needed for seller-invoice-links delete.
  // We discover it by scanning /orders with status omitted (most reliable across accounts).

  const lb = Number.isFinite(lookbackDays) ? Math.min(Math.max(lookbackDays, 1), 90) : 90;
  const windows = buildDateWindows(lb, 90, 14);

  const attempts: any[] = [];

  for (const w of windows) {
    const q = {
      status: "", // omit status param
      page: 0,
      size: 50,
      startDate: w.startDate,
      endDate: w.endDate,
      orderByField: "PackageLastModifiedDate",
      orderByDirection: "DESC",
    } as any;

    let data: any = null;
    let list: any[] = [];
    let source: string = "orders";
    let primaryErr: any = null;

    try {
      data = await trendyolGetOrders(cfg, q);
      const content = (data as any)?.content ?? [];
      list = Array.isArray(content) ? content : [];
    } catch (e: any) {
      primaryErr = e?.message || String(e);
      list = [];
    }

    // Fallback: legacy shipment-packages (some accounts return empty list on /orders)
    if (primaryErr || list.length === 0) {
      try {
        const legacyData = await trendyolGetShipmentPackagesLegacy(cfg, q);
        const legacyContent = (legacyData as any)?.content ?? [];
        const legacyList = Array.isArray(legacyContent) ? legacyContent : [];
        if (legacyList.length > 0) {
          data = legacyData;
          list = legacyList;
          source = "shipment-packages";
        }
      } catch {
        // ignore legacy errors
      }
    }

    const match = list.find((o: any) => {
      const sp = o?.shipmentPackageId ?? o?.packageId;
      return Number(sp) === shipmentPackageId;
    });

    attempts.push({ window: w, ok: true, source, contentCount: list.length, found: !!match, ...(primaryErr ? { ordersError: primaryErr } : {}) });

    if (match) {
      const customerId = Number(match?.customerId ?? match?.customer?.id);
      const cargoTrackingNumber = String(match?.cargoTrackingNumber ?? match?.trackingNumber ?? "").trim();
      return {
        ok: Number.isFinite(customerId) && customerId > 0,
        customerId: Number.isFinite(customerId) ? customerId : null,
        cargoTrackingNumber: cargoTrackingNumber || null,
        match,
        attempts,
      };
    }
  }

  return { ok: false, customerId: null, cargoTrackingNumber: null, match: null, attempts };
}


function isRetryableUpstreamStatus(status: number | null): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 556;
}

function parseCsv(v: unknown): string[] {
  const s = String(v ?? '').trim();
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}


// Trendyol.pdf: startDate/endDate ile sorguda maksimum zaman araligi 2 haftadir.
// Ayrica siparis gecmisi maksimum ~3 ay (90 gun) olarak belirtilir.
// Bu nedenle lookbackDays'i 90 gun ile sinirlayip 14 gunluk pencerelere boluyoruz.
function buildDateWindows(lookbackDays: number, maxHistoryDays = 90, windowDays = 14) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const lb = Math.min(Math.max(Number(lookbackDays) || 1, 1), maxHistoryDays);
  const now = Date.now();
  const windows: Array<{ startDate: number; endDate: number; days: number; offsetDays: number }> = [];

  let offset = 0;
  while (offset < lb) {
    const days = Math.min(windowDays, lb - offset);
    const endDate = now - offset * msPerDay;
    const startDate = endDate - days * msPerDay;
    windows.push({ startDate, endDate, days, offsetDays: offset });
    offset += days;
  }

  return windows;
}

function orderCarrierText(o: any): string {
  const parts = [o?.cargoProviderName, o?.cargoProvider, o?.cargoProviderCode, o?.cargoProviderType].filter(Boolean);
  return parts.map((x) => String(x).trim()).filter(Boolean).join(' | ');
}

function isMarketplaceCarrierText(carrier: string): boolean {
  const c = String(carrier ?? '').toLowerCase();
  // Trendyol data sometimes includes 'Marketplace' for non-contracted shipment flows.
  return c.includes('marketplace');
}

function expandCarrierWanted(wanted: string[]): string[] {
  const out = new Set<string>();
  for (const raw of wanted ?? []) {
    const t = String(raw ?? '').trim();
    if (!t) continue;
    out.add(t);
    const u = t.toUpperCase();

    // PDF: CommonLabel supports TEX (Trendyol Express) and ARAS. In data, provider often appears as "Trendyol Express".
    if (u === 'TEX' || u.includes('TRENDYOL EXPRESS') || u.includes('TRENDYOLEXPRESS')) {
      out.add('TEX');
      out.add('Trendyol Express');
      out.add('TRENDYOL EXPRESS');
      out.add('TrendyolEkspres');
      out.add('Trendyol Ekspres');
    }

    if (u === 'ARAS' || u.includes('ARAS')) {
      out.add('ARAS');
      out.add('Aras');
      out.add('ARAS KARGO');
      out.add('Aras Kargo');
    }
  }
  return Array.from(out);
}

function carrierMatches(o: any, wanted: string[]): boolean {
  if (!wanted || wanted.length === 0) return true;
  const carrier = orderCarrierText(o).toLowerCase();
  if (!carrier) return false;

  // Unless caller explicitly asks for Marketplace, treat Marketplace carriers as non-matching.
  // This prevents picking 'Aras Kargo Marketplace' when we really want contracted ARAS/TEX for CommonLabel.
  const wantsMarketplace = wanted.some((w) => String(w).toLowerCase().includes('marketplace'));
  if (!wantsMarketplace && isMarketplaceCarrierText(carrier)) return false;

  const expanded = expandCarrierWanted(wanted);
  return expanded.some((w) => carrier.includes(String(w).trim().toLowerCase()));
}



function normalizeCargoTrackingNumber(raw: unknown): { cargo: string; err?: { status: number; body: any } } {
  let cargo = String(raw ?? "").trim();
  if (cargo.startsWith("=")) cargo = cargo.slice(1).trim();
  if (!cargo) {
    return { cargo, err: { status: 400, body: { error: "missing_cargoTrackingNumber" } } };
  }
  // Heuristic: connectionId values are like cmk28... (Prisma IDs). Cargo tracking numbers are typically digits.
  if (/^cm[a-z0-9]{10,}$/i.test(cargo)) {
    return {
      cargo,
      err: {
        status: 400,
        body: {
          error: "cargoTrackingNumber_looks_like_connectionId",
          cargoTrackingNumber: cargo,
          hint: "cargoTrackingNumber must be the shipment tracking number (e.g. digits), not connectionId. Fix env: ECI_S11_CARGO_TRACKING_NUMBER",
        },
      },
    };
  }
  return { cargo };
}
function extractZplFromCommonLabelResponse(data: any): string {
  // Trendyol docs typically return: { data: [ { label: "...ZPL..." } ] }
  // But some gateways may return raw text. We handle both.
  if (typeof data === "string") return data;
  if (data == null) return "";
  const inner = (data as any).data;
  if (typeof inner === "string") return inner;
  if (Array.isArray(inner) && inner[0]?.label != null) return String(inner[0].label);
  if ((data as any).label != null) return String((data as any).label);
  return "";
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function findRepoRoot(startDir = process.cwd()): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) {
      try {
        const raw = fs.readFileSync(pj, "utf8");
        const json = JSON.parse(raw);
        if (json?.name === "eci") return dir;
      } catch {
        // ignore
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function sanitizeConfig(cfg: any) {
  // Proof/log hijyeni: credential alanlarını dökmeyelim.
  const clone = { ...(cfg ?? {}) };
  if (clone.token) clone.token = "***";
  if (clone.apiKey) clone.apiKey = "***";
  if (clone.apiSecret) clone.apiSecret = "***";
  return clone;
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
    agentName: String(cfg.agentName ?? "Easyso").trim(),
    integrationName: String(cfg.integrationName ?? "ECI").trim(),
    baseUrl: baseUrlRaw ? baseUrlRaw.replace(/\/+$/, "") : undefined,
  };
}

const TrendyolConfigSchema: z.ZodType<TrendyolConfig> = z
  .object({
    sellerId: z.string().min(1),
    env: z.enum(["prod", "stage"]).optional(),
    baseUrl: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    token: z.string().optional(),
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),
    preferSapigw: z.boolean().optional(),
    agentName: z.string().optional(),
    integrationName: z.string().optional(),
    probeLegacy: z.boolean().optional(),
  })
  .refine((v) => !!(v.token || (v.apiKey && v.apiSecret)), {
    message: "Trendyol config must include token or apiKey+apiSecret",
  });

async function loadTrendyolCfg(connectionId: string) {
  const conn = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { id: true, type: true, name: true, status: true, configEnc: true },
  });

  if (!conn) return { error: { status: 404, body: { error: "not_found", connectionId } } } as const;
  if (conn.type !== "trendyol")
    return { error: { status: 400, body: { error: "only_trendyol_supported", connectionId } } } as const;

  const cfgRaw = decryptJson(conn.configEnc);
  const parsed = TrendyolConfigSchema.safeParse(cfgRaw);
  if (!parsed.success) {
    return {
      error: {
        status: 400,
        body: { error: "invalid_connection_config", connectionId, issues: parsed.error.flatten() },
      },
    } as const;
  }

  const cfg = normalizeConfig(parsed.data);
  return { conn, cfg } as const;
}

async function pickDefaultTrendyolConnectionId() {
  const conns = await prisma.connection.findMany({
    where: { type: "trendyol", status: "active" },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  if (conns.length === 0) {
    return { error: { status: 404, body: { error: "no_active_trendyol_connection" } } } as const;
  }

  // Deterministic: newest active connection.
  return {
    connectionId: conns[0].id,
    autopicked: true,
    candidates: conns.map((c) => ({ id: c.id, name: c.name })),
  } as const;
}

// -----------------
// Request schemas
// -----------------

const CommonLabelCreateSchema = z
  .object({
    connectionId: z.string().min(1),
    cargoTrackingNumber: z.string().min(1),
    format: z.enum(["ZPL"]),
    boxQuantity: z.number().int().positive().optional(),
    volumetricHeight: z.number().positive().optional(),
  })
  .strict();

const SendInvoiceLinkSchema = z
  .object({
    connectionId: z.string().min(1),
    invoiceLink: z.string().url(),
    shipmentPackageId: z.number().int().positive(),
    invoiceDateTime: z.number().int().positive(),
    invoiceNumber: z.string().min(1),
  })
  .strict();

// Backward/compat schema (older client/proof drafts may send customerId etc.)
// We accept and ignore extra fields on the API boundary.
const SendInvoiceLinkCompatSchema = z
  .object({
    connectionId: z.string().min(1),
    invoiceLink: z.string().url(),
    shipmentPackageId: z.number().int().positive(),
    invoiceDateTime: z.number().int().positive(),
    invoiceNumber: z.string().min(1),
    customerId: z.number().int().positive().optional(),
  })
  .passthrough();

const DeleteInvoiceLinkSchema = z
  .object({
    connectionId: z.string().min(1),
    serviceSourceId: z.number().int().positive(),
    channelId: z.number().int().optional().default(1),
    customerId: z.number().int().positive(),
  })
  .strict();

function inferExt(contentType: string | undefined, filename: string | undefined): string {
  const fn = (filename ?? "").toLowerCase();
  if (fn.endsWith(".pdf")) return ".pdf";
  if (fn.endsWith(".png")) return ".png";
  if (fn.endsWith(".jpg") || fn.endsWith(".jpeg")) return ".jpg";

  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("pdf")) return ".pdf";
  if (ct.includes("png")) return ".png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  return "";
}

export function registerSprint11InvoiceLabelRoutes(app: Express) {
  // -----------------
  // Helper: sample order discovery (reduces placeholders)
  //
  // Why this exists:
  // - CommonLabel and Invoice endpoints require real IDs (cargoTrackingNumber, shipmentPackageId, customerId).
  // - Depending on the seller account and time of day, a single status (e.g. only "Picking") may return 0 orders.
  // - This endpoint therefore tries multiple statuses by default and returns a structured "attempts" array.
  //   If nothing is found, we still get a proof explaining *why* (which statuses were empty).
  //
  // Query:
  // - connectionId (required)
  // - status=Picking (optional; if set, only this single status is tried)
  // - statuses=Picking,Invoiced,Shipped,Created (optional; comma-separated list)
  // - size/page (optional; controls Trendyol /orders)
  //
  app.get(
    "/v1/sprint11/orders/sample",
    asyncHandler(async (req: Request, res: Response) => {
      const connectionIdRaw = String(req.query.connectionId ?? "").trim();

      const statusSingle = String(req.query.status ?? "").trim();
      const statusesCsv = String(req.query.statuses ?? "").trim();

      const size = Number(req.query.size ?? 10);
      const page = Number(req.query.page ?? 0);

      const carriersWantedCsv = String((req.query.carrier ?? req.query.carriers) ?? '').trim();
      const carriersWanted = carriersWantedCsv
        ? carriersWantedCsv.split(',').map((s) => s.trim()).filter(Boolean)
        : ['TEX', 'ARAS'];
      const carriersWantedExpanded = expandCarrierWanted(carriersWanted);

      // Trendyol.pdf: startDate/endDate ile sorguda maksimum zaman araligi 2 haftadir; daha genis araliklar bos/hatali donuslere sebep olabilir.
      // Ayrica siparis gecmisi maksimum ~3 ay (90 gun) olarak belirtilir.
      // Bu nedenle lookbackDays'i 90 gun ile sinirlayip 14 gunluk pencerelere boluyoruz.
      const lookbackDaysRaw = Number(req.query.lookbackDays ?? 30);
      const lookbackDays = Number.isFinite(lookbackDaysRaw) ? Math.min(Math.max(lookbackDaysRaw, 1), 90) : 30;
      const windows = buildDateWindows(lookbackDays, 90, 14);
      const endDate = windows[0]?.endDate ?? Date.now();
      const startDate = windows[windows.length - 1]?.startDate ?? (endDate - lookbackDays * 24 * 60 * 60 * 1000);

      // Trendyol.pdf: siparis/paket durumlari hesap bazinda farkli dagilabilir.
      // Operasyonel akista (etiket/fatura) test edebilmek icin varsayilan listeyi genis tutuyoruz.
      // (Still safe: bu endpoint sadece GET/ID kesfi + kanit uretir.)
      const defaultStatuses = [
        "Picking",
        "Invoiced",
        "Shipped",
        "Created",
        "AtCollectionPoint",
        "Awaiting",
        "Delivered",
        "Cancelled",
        "UnDelivered",
        "Returned",
        "Repack",
        "UnSupplied",
      ];

      const statusesBase = statusSingle
        ? [statusSingle]
        : statusesCsv
          ? statusesCsv
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : defaultStatuses;

      // Some seller accounts return results only when status param is omitted.
      // Default: include an extra attempt where we omit status.
      const includeNoStatus = req.query.includeNoStatus == null ? true : parseBool(req.query.includeNoStatus);
      const statuses = includeNoStatus ? ["", ...statusesBase] : statusesBase;

      const pick = (first: any) => {
        if (!first) return null;
        const shipmentPackageId = first.shipmentPackageId ?? first.packageId ?? null;
        const cargoTrackingNumber = first.cargoTrackingNumber ?? first.trackingNumber ?? null;
        const customerId = first.customerId ?? first?.customer?.id ?? null;
        const carrier = orderCarrierText(first) || null;
        return {
          shipmentPackageId,
          cargoTrackingNumber,
          customerId,
          status: first.status ?? null,
          carrier,
          orderNumber: first.orderNumber ?? first.orderNo ?? null,
          orderDate: first.orderDate ?? null,
        };
      };

      // Determine which connections to try.
      let connectionIds: string[] = [];
      if (connectionIdRaw) {
        connectionIds = [connectionIdRaw];
      } else {
        const conns = await prisma.connection.findMany({
          where: { type: "trendyol", status: "active" },
          select: { id: true },
          orderBy: { createdAt: "desc" },
        });
        connectionIds = conns.map((c) => c.id);
      }

      if (connectionIds.length === 0) {
        return res.status(404).json({ error: "no_trendyol_connections" });
      }

      const attempts: any[] = [];
      const connectionsTried: any[] = [];

      let pickedConnection: any = null;
      let forLabel: any = null;
      let forInvoice: any = null;
      let firstAny: any = null;

      // Try connections until we can extract a usable cargoTrackingNumber or shipmentPackageId.
      for (const connectionId of connectionIds) {
        const loaded = await loadTrendyolCfg(connectionId);
        if ((loaded as any).error) {
          attempts.push({ connectionId, error: (loaded as any).error.body });
          continue;
        }

        const { cfg, conn } = loaded as any;
        connectionsTried.push({ id: conn.id, name: conn.name, status: conn.status });

        let localForLabel: any = null;
        let localForLabelMatched = false;
        let localForLabelFallbackAny: any = null;
        let localForInvoice: any = null;
        let localFirstAny: any = null;

        const probeLegacy = req.query.probeLegacy == null ? true : parseBool(req.query.probeLegacy);
        const fetchPackages = async (q: any) => {
          let ordersData: any = null;
          let ordersList: any[] = [];
          let ordersErr: any = null;

          // 1) primary: /orders (canonical)
          try {
            ordersData = await trendyolGetOrders(cfg, q);
            const content = (ordersData as any)?.content ?? [];
            ordersList = Array.isArray(content) ? content : [];
          } catch (e: any) {
            ordersErr = { source: 'orders', message: e?.message || String(e) };
          }

          // 2) optional legacy probe: /shipment-packages
          // Many accounts return 401/403 here even when /orders works.
          // So legacy failures MUST NOT mask /orders results.
          if (!probeLegacy) {
            return {
              source: 'orders',
              data: ordersData,
              list: ordersList,
              error: ordersErr,
              legacyProbe: { tried: false },
            };
          }

          const shouldTryLegacy = !!ordersErr || ordersList.length === 0;
          if (!shouldTryLegacy) {
            return {
              source: 'orders',
              data: ordersData,
              list: ordersList,
              error: null,
              legacyProbe: { tried: false },
            };
          }

          try {
            const legacyData = await trendyolGetShipmentPackagesLegacy(cfg, q);
            const legacyContent = (legacyData as any)?.content ?? [];
            const legacyList = Array.isArray(legacyContent) ? legacyContent : [];

            if (legacyList.length > 0) {
              return {
                source: 'shipment-packages',
                data: legacyData,
                list: legacyList,
                error: ordersErr,
                legacyProbe: { tried: true, ok: true, count: legacyList.length },
              };
            }

            // Legacy ok but empty -> keep /orders view as canonical
            return {
              source: 'orders',
              data: ordersData,
              list: ordersList,
              error: ordersErr,
              legacyProbe: { tried: true, ok: true, count: 0 },
            };
          } catch (e: any) {
            const legacyErr = { source: 'legacy', message: e?.message || String(e) };
            return {
              source: 'orders',
              data: ordersData,
              list: ordersList,
              error: ordersErr,
              legacyProbe: { tried: true, ok: false, error: legacyErr },
            };
          }
        };

        for (const st of statuses) {
          for (const w of windows) {
            const q = {
              status: st, // "" => omit status param (see connector)
              size: Number.isFinite(size) ? Math.min(Math.max(size, 1), 50) : 10,
              page: Number.isFinite(page) ? Math.max(page, 0) : 0,
              startDate: w.startDate,
              endDate: w.endDate,
              orderByField: "PackageLastModifiedDate",
              orderByDirection: "DESC",
            };

            const fetched = await fetchPackages(q);
            const data = fetched.data;
            const list = fetched.list;

            const first = list[0];
            if (!localFirstAny && first) localFirstAny = first;

            const labelCandidateMatched = list.find((o: any) => !!(o?.cargoTrackingNumber ?? o?.trackingNumber) && carrierMatches(o, carriersWantedExpanded));
            const labelCandidateAny =
            list.find((o: any) => !!(o?.cargoTrackingNumber ?? o?.trackingNumber) && !isMarketplaceCarrierText(orderCarrierText(o))) ??
            list.find((o: any) => !!(o?.cargoTrackingNumber ?? o?.trackingNumber));
            const invoiceCandidate = list.find((o: any) => (o?.shipmentPackageId ?? o?.packageId) != null);

            if (!localForLabel && labelCandidateMatched) {
              localForLabel = pick(labelCandidateMatched);
              localForLabelMatched = true;
            }
            if (!localForLabelFallbackAny && labelCandidateAny) localForLabelFallbackAny = pick(labelCandidateAny);
            if (!localForInvoice && invoiceCandidate) localForInvoice = pick(invoiceCandidate);

            attempts.push({
              connectionId: conn.id,
              connectionName: conn.name,
              status: st,
              window: { offsetDays: w.offsetDays, days: w.days, startDate: w.startDate, endDate: w.endDate },
              source: fetched.source,
              legacyProbe: fetched.legacyProbe,
              ...(fetched.error ? { fetchError: fetched.error } : {}),
              totalElements: (data as any)?.totalElements ?? null,
              totalPages: (data as any)?.totalPages ?? null,
              page: (data as any)?.page ?? null,
              size: (data as any)?.size ?? null,
              contentCount: list.length,
              sample: pick(first),
            });

            // We only stop scanning windows once we have a GOOD label candidate (carrier-matched) AND invoice ids.
            // If a window has content but only Marketplace carriers, we keep scanning older windows to find TEX/ARAS contracted flows.
            if (localForLabelMatched && localForLabel?.cargoTrackingNumber && localForInvoice?.shipmentPackageId) break;
          }

          if (localForLabel?.cargoTrackingNumber && localForInvoice?.shipmentPackageId) break;
        }


        // If we couldn't find a carrier-matched label candidate, fall back to any label candidate we saw.
        if (!localForLabel && localForLabelFallbackAny) localForLabel = localForLabelFallbackAny;

        const localSample = localForLabel ?? localForInvoice ?? pick(localFirstAny);

        if (localSample?.cargoTrackingNumber || localSample?.shipmentPackageId) {
          pickedConnection = { id: conn.id, name: conn.name, status: conn.status, config: sanitizeConfig(cfg) };
          forLabel = localForLabel;
          forInvoice = localForInvoice;
          firstAny = localFirstAny;
          break;
        }

        // Keep best-effort data for the first connection only (if none found), so response still useful.
        if (!pickedConnection && !firstAny && localFirstAny) {
          firstAny = localFirstAny;
        }
      }

      const sample = forLabel ?? forInvoice ?? pick(firstAny);

      return res.json({
        ok: true,
        pickedConnection,
        connectionsTried,
        criteria: {
          connectionId: connectionIdRaw || null,
          statusesTried: statuses.map((s) => (s ? s : "(no status)")),
          carriersWanted: carriersWantedExpanded,
          size: Number.isFinite(size) ? size : null,
          page: Number.isFinite(page) ? page : null,
          lookbackDays,
          startDate,
          endDate,
          windows: { count: windows.length, windowDays: 14, maxHistoryDays: 90 },
          note: "If no sample is found, check attempts[] (status + window) for which combinations were empty and whether seller has any orders in the last 90 days.",
        },
        attempts,
        forLabel,
        forInvoice,
        sample,
        note:
          "PDF: commonlabel (etiket) akisi picking/invoiced gibi statuslerden sonra anlamli olur. Bu endpoint sadece ID kesfi + kanit icindir.",
      });
    }),
  );

  // -----------------
  // Sprint 11.1A Helper: Promote a shipment package to Picking -> Invoiced
  // -----------------
  // Why: CommonLabel akisi (PDF) picking/invoiced sonrasinda anlamli. Bizde sample bazen Created kaliyor.
  // This endpoint:
  //  - finds the package in /orders (status omitted) within last N days (chunked windows)
  //  - extracts lineIds + quantities
  //  - calls updatePackage (PUT shipment-packages/{id}) for Picking, then Invoiced
  app.post(
    "/v1/sprint11/shipment-packages/:packageId/promote",
    asyncHandler(async (req: Request, res: Response) => {
      const packageId = String((req.params as any).packageId ?? '').trim();
      if (!packageId) return res.status(400).json({ error: "missing_packageId" });

      let connectionId = String(req.query.connectionId ?? (req.body as any)?.connectionId ?? '').trim();
      let autopicked: any = null;
      if (!connectionId) {
        const pick = await pickDefaultTrendyolConnectionId();
        if ((pick as any).error) return res.status((pick as any).error.status).json((pick as any).error.body);
        connectionId = (pick as any).connectionId;
        autopicked = { connectionId, candidates: (pick as any).candidates };
      }

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg, conn } = loaded as any;

      const lookbackDaysRaw = Number(req.query.lookbackDays ?? 14);
      const lookbackDays = Number.isFinite(lookbackDaysRaw) ? Math.min(Math.max(lookbackDaysRaw, 1), 90) : 14;
      const windows = buildDateWindows(lookbackDays, 90, 14);

      // Find the order/package payload that includes this shipmentPackageId.
      const attempts: any[] = [];
      let found: any = null;

      for (const w of windows) {
        try {
          const data = await trendyolGetOrders(cfg, {
            status: "", // omit status param
            page: 0,
            size: 50,
            startDate: w.startDate,
            endDate: w.endDate,
            orderByField: "PackageLastModifiedDate",
            orderByDirection: "DESC",
          } as any);
          const content = (data as any)?.content ?? [];
          const list = Array.isArray(content) ? content : [];
          const match = list.find((o: any) => String(o?.shipmentPackageId ?? o?.packageId ?? '').trim() === packageId);
          attempts.push({ window: w, ok: true, contentCount: list.length });
          if (match) {
            found = match;
            break;
          }
        } catch (e: any) {
          attempts.push({ window: w, ok: false, error: e?.message || String(e) });
        }
      }

      if (!found) {
        return res.status(404).json({
          error: "package_not_found_in_orders",
          connection: { id: conn.id, name: conn.name, status: conn.status },
          packageId,
          lookbackDays,
          windowsTried: windows.length,
          attempts,
          hint: "Bu shipmentPackageId son 90 gunde /orders icinde bulunamadi. Paket cok yeni/eski olabilir veya baska connection'a ait olabilir.",
        });
      }

      const lines = extractUpdatePackageLines(found);
      if (!lines.length) {
        return res.status(422).json({
          error: "no_lines_found_for_package",
          connection: { id: conn.id, name: conn.name, status: conn.status },
          packageId,
          foundKeys: Object.keys(found ?? {}),
          hint: "Trendyol /orders cevabinda lines/orderLines alani bulunamadi. PDF'e gore updatePackage icin lineId+quantity gerekir.",
        });
      }

      const invoiceNumber = normalizeInvoiceNumber(req.query.invoiceNumber ?? (req.body as any)?.invoiceNumber, packageId);

      const payloadBase = { lines };

      // 1) Picking
      const pickingPayload: any = { ...payloadBase, status: "Picking", params: {} };
      const picking = await trendyolUpdatePackage(cfg, { shipmentPackageId: packageId, ...pickingPayload });

      // small pause to let state propagate
      await sleep(400);

      // 2) Invoiced
      const invoicedPayload: any = { ...payloadBase, status: "Invoiced", params: { invoiceNumber } };
      const invoiced = await trendyolUpdatePackage(cfg, { shipmentPackageId: packageId, ...invoicedPayload });

      return res.status(200).json({
        ok: true,
        connection: { id: conn.id, name: conn.name, status: conn.status },
        ...(autopicked ? { autopicked } : {}),
        packageId,
        orderNumber: found?.orderNumber ?? found?.orderNo ?? null,
        currentStatus: found?.status ?? null,
        linesCount: lines.length,
        invoiceNumber,
        picking,
        invoiced,
        attempts,
      });
    }),
  );

  // -----------------
  // Addresses (getSuppliersAddresses)
  // -----------------
  app.get(
    "/v1/sprint11/seller/addresses",
    asyncHandler(async (req: Request, res: Response) => {
      let connectionId = String(req.query.connectionId ?? "").trim();
      let autopicked: any = null;
      if (!connectionId) {
        const pick = await pickDefaultTrendyolConnectionId();
        if ((pick as any).error) return res.status((pick as any).error.status).json((pick as any).error.body);
        connectionId = (pick as any).connectionId;
        autopicked = { connectionId, candidates: (pick as any).candidates };
      }

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg, conn } = loaded as any;

      const data = await trendyolGetSuppliersAddresses(cfg);
      return res.json({
        ok: true,
        connection: { id: conn.id, name: conn.name, status: conn.status },
        ...(autopicked ? { autopicked } : {}),
        data,
      });
    }),
  );

  // -----------------
  // Common Label: create + get + download
  // -----------------
  app.post(
    "/v1/sprint11/labels/common/create",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = CommonLabelCreateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const { connectionId, cargoTrackingNumber: cargoTrackingNumberRaw, format, boxQuantity, volumetricHeight } = parsed.data;

      const normCargo = normalizeCargoTrackingNumber(cargoTrackingNumberRaw);
      if (normCargo.err) return res.status(normCargo.err.status).json(normCargo.err.body);
      const cargoTrackingNumber = normCargo.cargo;
      const dryRun = parseBool(req.query.dryRun);

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg } = loaded as any;

      const payload: any = { format };
      if (typeof boxQuantity === "number") payload.boxQuantity = boxQuantity;
      if (typeof volumetricHeight === "number") payload.volumetricHeight = volumetricHeight;

      if (dryRun) {
        return res.json({ ok: true, dryRun: true, wouldCall: "createCommonLabel", cargoTrackingNumber, payload });
      }

      const out = await trendyolCreateCommonLabel(cfg, cargoTrackingNumber, payload);
      // Trendyol: 200, no response body. Biz status + küçük meta dönelim.
      return res.status(200).json({ ok: true, cargoTrackingNumber, result: out });
    }),
  );

  
  // Common Label: ensure (create + retry/poll get)
  // Goal: tek çağrıda ZPL'e ulaşmak (Trendyol 556/503 gibi geçici hatalarda retry yapar).
  app.all(
    "/v1/sprint11/labels/common/ensure",
    asyncHandler(async (req: Request, res: Response) => {
      let connectionId = String(req.query.connectionId ?? '').trim();
      let autopicked: any = null;
      if (!connectionId) {
        const pick = await pickDefaultTrendyolConnectionId();
        if ((pick as any).error) return res.status((pick as any).error.status).json((pick as any).error.body);
        connectionId = (pick as any).connectionId;
        autopicked = { connectionId, candidates: (pick as any).candidates };
      }

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg } = loaded as any;

      const carriersWantedCsv = String((req.query.carrier ?? req.query.carriers) ?? '').trim();
      const carriersWanted = carriersWantedCsv
        ? carriersWantedCsv.split(',').map((s) => s.trim()).filter(Boolean)
        : ['TEX', 'ARAS'];
      const carriersWantedExpanded = expandCarrierWanted(carriersWanted);

      const dryRun = parseBool(req.query.dryRun);
      const createFirst =
        req.query.create != null
          ? parseBool(req.query.create)
          : req.query.createFirst != null
            ? parseBool(req.query.createFirst)
            : true;
      const maxAttemptsRaw = Number(req.query.maxAttempts ?? 6);
      const maxAttempts = Number.isFinite(maxAttemptsRaw) ? Math.min(Math.max(maxAttemptsRaw, 1), 15) : 6;
      const baseDelayMsRaw = Number(req.query.baseDelayMs ?? 900);
      const baseDelayMs = Number.isFinite(baseDelayMsRaw) ? Math.min(Math.max(baseDelayMsRaw, 100), 5000) : 900;
      const maxDelayMsRaw = Number(req.query.maxDelayMs ?? 3500);
      const maxDelayMs = Number.isFinite(maxDelayMsRaw) ? Math.min(Math.max(maxDelayMsRaw, 200), 10000) : 3500;

      const probeLegacy = req.query.probeLegacy == null ? true : parseBool(req.query.probeLegacy);

      const cargoFromBody = (req.body && typeof req.body === 'object') ? (req.body as any).cargoTrackingNumber : undefined;
      const cargoFromQuery = req.query.cargoTrackingNumber;
      const cargoFromEnv = process.env.ECI_S11_CARGO_TRACKING_NUMBER;

      const cargoSeedRaw = cargoFromBody ?? cargoFromQuery ?? cargoFromEnv ?? '';
      const cargoSeed = String(cargoSeedRaw ?? '').trim();

      // When caller provides cargoTrackingNumber, skip expensive order discovery by default.
      const discoverAlternatives = req.query.discoverAlternatives == null ? false : parseBool(req.query.discoverAlternatives);
      const doDiscovery = discoverAlternatives || cargoSeed.length === 0;

      // If we don't have a cargoTrackingNumber (or want alternates), discover candidates from orders.
      type Candidate = { cargoTrackingNumber: string; status: string; carrier: string };
      const matchedCandidates: Candidate[] = [];
      const anyCandidates: Candidate[] = [];

      // Lookback: Trendyol.pdf limitleri (max ~90 gun tarihce, max 14 gun zaman araligi)
      const lookbackDaysRaw = Number(req.query.lookbackDays ?? 30);
      const lookbackDays = Number.isFinite(lookbackDaysRaw) ? Math.min(Math.max(lookbackDaysRaw, 1), 90) : 30;
      const windows = buildDateWindows(lookbackDays, 90, 14);
      const endDate = windows[0]?.endDate ?? Date.now();
      const startDate = windows[windows.length - 1]?.startDate ?? (endDate - lookbackDays * 24 * 60 * 60 * 1000);
      const statusesCsv = String(req.query.statuses ?? '').trim();
      const statuses = statusesCsv
        ? statusesCsv.split(',').map((s) => s.trim()).filter(Boolean)
        : ['Picking', 'Invoiced'];

      const includeNoStatus = req.query.includeNoStatus == null ? true : parseBool(String(req.query.includeNoStatus));
      const statusesToTry = includeNoStatus ? [''].concat(statuses) : statuses;

      // Discover up to 5 candidates.
      // - Prefer carriersWanted (TEX/ARAS, synonyms expanded)
      // - If none match carriers, fall back to ANY carrier in the same statuses
      // - IMPORTANT: Eğer /orders boş dönüyorsa, legacy /shipment-packages ile tekrar deniyoruz.
      const discovery: {
        perStatus: Array<{ status: string; window: { offsetDays: number; days: number; startDate: number; endDate: number }; source: string; legacyProbe: any; contentCount: number; error?: any }>;
      } = { perStatus: [] };
      const fetchPackages = async (q: any) => {
        let ordersData: any = null;
        let ordersList: any[] = [];
        let ordersErr: any = null;

        // 1) primary: /orders (canonical)
        try {
          ordersData = await trendyolGetOrders(cfg, q);
          const content = (ordersData as any)?.content ?? [];
          ordersList = Array.isArray(content) ? content : [];
        } catch (e: any) {
          ordersErr = { source: 'orders', message: e?.message || String(e) };
        }

        // 2) optional legacy probe: /shipment-packages
        // Many accounts return 401/403 here even when /orders works.
        // So legacy failures MUST NOT mask /orders results.
        if (!probeLegacy) {
          return {
            source: 'orders',
            data: ordersData,
            list: ordersList,
            error: ordersErr,
            legacyProbe: { tried: false },
          };
        }

        const shouldTryLegacy = !!ordersErr || ordersList.length === 0;
        if (!shouldTryLegacy) {
          return {
            source: 'orders',
            data: ordersData,
            list: ordersList,
            error: null,
            legacyProbe: { tried: false },
          };
        }

        try {
          const legacyData = await trendyolGetShipmentPackagesLegacy(cfg, q);
          const legacyContent = (legacyData as any)?.content ?? [];
          const legacyList = Array.isArray(legacyContent) ? legacyContent : [];

          if (legacyList.length > 0) {
            return {
              source: 'shipment-packages',
              data: legacyData,
              list: legacyList,
              error: ordersErr,
              legacyProbe: { tried: true, ok: true, count: legacyList.length },
            };
          }

          // Legacy ok but empty -> keep /orders view as canonical
          return {
            source: 'orders',
            data: ordersData,
            list: ordersList,
            error: ordersErr,
            legacyProbe: { tried: true, ok: true, count: 0 },
          };
        } catch (e: any) {
          const legacyErr = { source: 'legacy', message: e?.message || String(e) };
          return {
            source: 'orders',
            data: ordersData,
            list: ordersList,
            error: ordersErr,
            legacyProbe: { tried: true, ok: false, error: legacyErr },
          };
        }
      };

      if (doDiscovery) {
        for (const st of statusesToTry) {
          for (const w of windows) {
            const fetched = await fetchPackages({
              status: st,
              size: 50,
              page: 0,
              startDate: w.startDate,
              endDate: w.endDate,
              orderByField: 'PackageLastModifiedDate',
              orderByDirection: 'DESC',
            });

            discovery.perStatus.push({
              status: st ? st : "(no status)",
              window: { offsetDays: w.offsetDays, days: w.days, startDate: w.startDate, endDate: w.endDate },
              source: fetched.source,
              legacyProbe: fetched.legacyProbe,
              contentCount: fetched.list.length,
              ...(fetched.error ? { error: fetched.error } : {}),
            });

            for (const o of fetched.list) {
              const ctn = String(o?.cargoTrackingNumber ?? o?.trackingNumber ?? '').trim();
              if (!ctn) continue;
              const carrier = orderCarrierText(o);

              if (!anyCandidates.some((c) => c.cargoTrackingNumber === ctn)) {
                anyCandidates.push({ cargoTrackingNumber: ctn, status: st ? st : "(no status)", carrier });
              }

              if (carrierMatches(o, carriersWantedExpanded) && !matchedCandidates.some((c) => c.cargoTrackingNumber === ctn)) {
                matchedCandidates.push({ cargoTrackingNumber: ctn, status: st ? st : "(no status)", carrier });
              }

              if (matchedCandidates.length >= 5 && anyCandidates.length >= 5) break;
            }

            // If we found at least one carrier match for this status, don't go further back.
            // IMPORTANT: If the window has content but none match (often Marketplace carriers), keep scanning older windows.
            if (matchedCandidates.length > 0) {
              break;
            }

            if (matchedCandidates.length >= 5 && anyCandidates.length >= 5) break;
          }

          if (matchedCandidates.length >= 5 && anyCandidates.length >= 5) break;
        }
      }


      const carrierMatchMode = matchedCandidates.length > 0 ? 'matched' : (cargoSeed ? 'manual_seed' : 'fallback_any');

      const rankCarrier = (carrierText: string) => {
        const c = String(carrierText ?? '').toLowerCase();
        if (c.includes('trendyol') && c.includes('express')) return 0;
        if (c.includes('aras')) return 1;
        return 2;
      };

      const sortByPreference = (arr: Candidate[]) =>
        [...arr].sort((a, b) => {
          const ra = rankCarrier(a.carrier);
          const rb = rankCarrier(b.carrier);
          if (ra != rb) return ra - rb;
          return String(a.status).localeCompare(String(b.status));
        });

      // Prefer carrier matches; if none, fall back to any NON-marketplace candidates.
      const nonMarketplaceAny = anyCandidates.filter((c) => !isMarketplaceCarrierText(c.carrier));
      const baseCandidates = matchedCandidates.length > 0 ? matchedCandidates : nonMarketplaceAny;
      const pickedCandidates = sortByPreference(baseCandidates).slice(0, 5);
const cargosToTry: string[] = [];
      if (cargoSeed) cargosToTry.push(cargoSeed);
      for (const c of pickedCandidates) {
        if (!cargosToTry.includes(c.cargoTrackingNumber)) cargosToTry.push(c.cargoTrackingNumber);
      }
      if (cargosToTry.length === 0) {
        // Diagnostic: show what exists in the given statuses (even if carrier doesn't match)
        const debugCandidates: any[] = [];
        const debugFetch: any[] = [];
        const debugStatuses = [...new Set([...statuses, 'ReadyToShip', 'Shipped', 'Delivered'])];
        for (const st of debugStatuses) {
          if (debugCandidates.length >= 5) break;
          try {
            const fetched = await fetchPackages({
              status: st,
              size: 50,
              page: 0,
              startDate,
              endDate,
              orderByField: 'PackageLastModifiedDate',
              orderByDirection: 'DESC',
            });

            debugFetch.push({ status: st, source: fetched.source, legacyProbe: fetched.legacyProbe, contentCount: fetched.list.length, ...(fetched.error ? { error: fetched.error } : {}) });

            for (const o of fetched.list) {
              const ctn = String(o?.cargoTrackingNumber ?? o?.trackingNumber ?? '').trim();
              if (!ctn) continue;
              debugCandidates.push({
                cargoTrackingNumber: ctn,
                status: st,
                carrier: orderCarrierText(o),
              });
              if (debugCandidates.length >= 5) break;
            }
          } catch {
            // ignore
          }
        }

        // Final fallback: some accounts return data only when status param is omitted.
        if (debugCandidates.length === 0) {
          try {
            const fetched = await fetchPackages({
              status: null, // omit status
              size: 50,
              page: 0,
              startDate,
              endDate,
              orderByField: 'PackageLastModifiedDate',
              orderByDirection: 'DESC',
            });
            debugFetch.push({ status: '(no status)', source: fetched.source, legacyProbe: fetched.legacyProbe, contentCount: fetched.list.length, ...(fetched.error ? { error: fetched.error } : {}) });
            for (const o of fetched.list) {
              const ctn = String(o?.cargoTrackingNumber ?? o?.trackingNumber ?? '').trim();
              if (!ctn) continue;
              debugCandidates.push({ cargoTrackingNumber: ctn, status: '(no status)', carrier: orderCarrierText(o) });
              if (debugCandidates.length >= 5) break;
            }
          } catch {
            // ignore
          }
        }

        return res.status(404).json({
          error: 'no_cargo_candidate_found',
          connectionId,
          carriersWanted: carriersWantedExpanded,
          carrierMatchMode,
          pickedCandidates,
          lookbackDays,
          statusesTried: statusesToTry.map((s) => (s ? s : "(no status)")),
          discovery,
          debugCandidates,
          debugFetch,
          hint:
            'No matching cargoTrackingNumber found in the requested statuses/windows. Try: (1) pass ?cargoTrackingNumber=... to force a known cargoTrackingNumber, (2) reduce lookbackDays to <=90, (3) ensure there is at least one Picking/Invoiced package in the last 90 days.',
        });
      }

      if (dryRun) {
        return res.json({
          ok: true,
          dryRun: true,
          wouldDo: { createFirst, maxAttempts, baseDelayMs, maxDelayMs },
          connectionId,
          ...(autopicked ? { autopicked } : {}),
          carriersWanted: carriersWantedExpanded,
          carrierMatchMode,
          pickedCandidates,
          cargosToTry,
          windows: { count: windows.length, windowDays: 14, maxHistoryDays: 90 },
        });
      }

      const results: any[] = [];
      for (const cargoTrackingNumberRaw2 of cargosToTry) {
        const normCargo2 = normalizeCargoTrackingNumber(cargoTrackingNumberRaw2);
        if (normCargo2.err) {
          results.push({ cargoTrackingNumber: cargoTrackingNumberRaw2, error: normCargo2.err.body });
          continue;
        }
        const cargoTrackingNumber = normCargo2.cargo;

        const payload: any = { format: 'ZPL' };

        if (createFirst) {
          try {
            await trendyolCreateCommonLabel(cfg, cargoTrackingNumber, payload);
          } catch (e: any) {
            const message = e?.message || String(e);
            const upstreamStatus = parseUpstreamStatusFromErrorMessage(message);
            results.push({ cargoTrackingNumber, stage: 'create', upstreamStatus, message });
            if (!isRetryableUpstreamStatus(upstreamStatus)) {
              continue;
            }
          }
        }

        const attempts: any[] = [];
        let lastErr: any = null;
        for (let i = 0; i < maxAttempts; i++) {
          try {
            const data = await trendyolGetCommonLabel(cfg, cargoTrackingNumber);
            const zpl = extractZplFromCommonLabelResponse(data);
            if (zpl) {
              const baseUrl = `${req.protocol}://${req.get('host')}`;
              const downloadUrl = `${baseUrl}/v1/sprint11/labels/common/${cargoTrackingNumber}/download?connectionId=${connectionId}`;
              return res.status(200).json({
                ok: true,
                cargoTrackingNumber,
                connectionId,
                ...(autopicked ? { autopicked } : {}),
                carriersWanted: carriersWantedExpanded,
                zplPreview: zpl.slice(0, 200),
                zplLength: zpl.length,
                downloadUrl,
                data,
                attempts,
                tried: cargosToTry,
              });
            }
            // Not ready yet -> wait and retry
            const waitMs = Math.min(maxDelayMs, baseDelayMs * (2 ** i));
            attempts.push({ attempt: i + 1, ok: true, zplEmpty: true, waitMs });
            await sleep(waitMs);
          } catch (e: any) {
            const message = e?.message || String(e);
            const upstreamStatus = parseUpstreamStatusFromErrorMessage(message);
            lastErr = { upstreamStatus, message };
            const waitMs = Math.min(maxDelayMs, baseDelayMs * (2 ** i));
            attempts.push({ attempt: i + 1, ok: false, upstreamStatus, message, waitMs });
            if (!isRetryableUpstreamStatus(upstreamStatus)) break;
            await sleep(waitMs);
          }
        }

        results.push({ cargoTrackingNumber, stage: 'get', attempts, lastErr });
      }

      return res.status(502).json({
        error: 'commonlabel_not_available',
        connectionId,
        ...(autopicked ? { autopicked } : {}),
        carriersWanted,
        carrierMatchMode,
        pickedCandidates,
        cargosToTry,
        windows: { count: windows.length, windowDays: 14, maxHistoryDays: 90 },
        results,
      });
    }),
  );

app.get(
    "/v1/sprint11/labels/common/:cargoTrackingNumber",
    asyncHandler(async (req: Request, res: Response) => {
      const normCargo = normalizeCargoTrackingNumber(req.params.cargoTrackingNumber);
      if (normCargo.err) return res.status(normCargo.err.status).json(normCargo.err.body);
      const cargoTrackingNumber = normCargo.cargo;
      let connectionId = String(req.query.connectionId ?? "").trim();
      let autopicked: any = null;
      if (!connectionId) {
        const pick = await pickDefaultTrendyolConnectionId();
        if ((pick as any).error) return res.status((pick as any).error.status).json((pick as any).error.body);
        connectionId = (pick as any).connectionId;
        autopicked = { connectionId, candidates: (pick as any).candidates };
      }
      if (!cargoTrackingNumber) return res.status(400).json({ error: "missing_cargoTrackingNumber" });

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg } = loaded as any;

      let data: any;
      try {
        data = await trendyolGetCommonLabel(cfg, cargoTrackingNumber);
      } catch (e: any) {
        const message = e?.message || String(e);
        const upstreamStatus = parseUpstreamStatusFromErrorMessage(message);
        return res.status(502).json({
          error: "upstream_error",
          upstreamStatus,
          message,
          cargoTrackingNumber,
          connectionId,
          ...(autopicked ? { autopicked } : {}),
        });
      }

      const zpl = extractZplFromCommonLabelResponse(data);
      return res.json({
        ok: true,
        cargoTrackingNumber,
        connectionId,
        ...(autopicked ? { autopicked } : {}),
        zplPreview: zpl ? zpl.slice(0, 200) : "",
        data,
      });
    }),
  );

  // Compatibility alias (older drafts used query param names)
  // GET /v1/sprint11/label/common/get?connectionId=...&cargoTrackingNumber=...
  app.get(
    "/v1/sprint11/label/common/get",
    asyncHandler(async (req: Request, res: Response) => {
      let connectionId = String(req.query.connectionId ?? "").trim();
      let autopicked: any = null;
      if (!connectionId) {
        const pick = await pickDefaultTrendyolConnectionId();
        if ((pick as any).error) return res.status((pick as any).error.status).json((pick as any).error.body);
        connectionId = (pick as any).connectionId;
        autopicked = { connectionId, candidates: (pick as any).candidates };
      }
      const normCargo = normalizeCargoTrackingNumber(req.query.cargoTrackingNumber);
      if (normCargo.err) return res.status(normCargo.err.status).json(normCargo.err.body);
      const cargoTrackingNumber = normCargo.cargo;

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg } = loaded as any;

      let data: any;
      try {
        data = await trendyolGetCommonLabel(cfg, cargoTrackingNumber);
      } catch (e: any) {
        const message = e?.message || String(e);
        const upstreamStatus = parseUpstreamStatusFromErrorMessage(message);
        return res.status(502).json({
          error: "upstream_error",
          upstreamStatus,
          message,
          cargoTrackingNumber,
          connectionId,
          ...(autopicked ? { autopicked } : {}),
        });
      }

      const zpl = extractZplFromCommonLabelResponse(data);
      return res.json({
        ok: true,
        alias: true,
        cargoTrackingNumber,
        connectionId,
        ...(autopicked ? { autopicked } : {}),
        zplPreview: zpl ? zpl.slice(0, 200) : "",
        data,
      });
    }),
  );

  app.get(
    "/v1/sprint11/labels/common/:cargoTrackingNumber/download",
    asyncHandler(async (req: Request, res: Response) => {
      const normCargo = normalizeCargoTrackingNumber(req.params.cargoTrackingNumber);
      if (normCargo.err) return res.status(normCargo.err.status).json(normCargo.err.body);
      const cargoTrackingNumber = normCargo.cargo;
      let connectionId = String(req.query.connectionId ?? "").trim();
      if (!connectionId) {
        const pick = await pickDefaultTrendyolConnectionId();
        if ((pick as any).error) return res.status((pick as any).error.status).json((pick as any).error.body);
        connectionId = (pick as any).connectionId;
      }
      if (!cargoTrackingNumber) return res.status(400).json({ error: "missing_cargoTrackingNumber" });

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg } = loaded as any;

      let data: any;
      try {
        data = await trendyolGetCommonLabel(cfg, cargoTrackingNumber);
      } catch (e: any) {
        const message = e?.message || String(e);
        const upstreamStatus = parseUpstreamStatusFromErrorMessage(message);
        return res.status(502).json({
          error: "upstream_error",
          upstreamStatus,
          message,
          cargoTrackingNumber,
          connectionId,
        });
      }

      const zpl = extractZplFromCommonLabelResponse(data);

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="commonlabel_${cargoTrackingNumber}.zpl"`,
      );
      return res.status(200).send(zpl);
    }),
  );

  // Compatibility alias (download)
  // GET /v1/sprint11/label/common/download?connectionId=...&cargoTrackingNumber=...
  app.get(
    "/v1/sprint11/label/common/download",
    asyncHandler(async (req: Request, res: Response) => {
      let connectionId = String(req.query.connectionId ?? "").trim();
      if (!connectionId) {
        const pick = await pickDefaultTrendyolConnectionId();
        if ((pick as any).error) return res.status((pick as any).error.status).json((pick as any).error.body);
        connectionId = (pick as any).connectionId;
      }
      const normCargo = normalizeCargoTrackingNumber(req.query.cargoTrackingNumber);
      if (normCargo.err) return res.status(normCargo.err.status).json(normCargo.err.body);
      const cargoTrackingNumber = normCargo.cargo;

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg } = loaded as any;

      let data: any;
      try {
        data = await trendyolGetCommonLabel(cfg, cargoTrackingNumber);
      } catch (e: any) {
        const message = e?.message || String(e);
        const upstreamStatus = parseUpstreamStatusFromErrorMessage(message);
        return res.status(502).json({
          error: "upstream_error",
          upstreamStatus,
          message,
          cargoTrackingNumber,
          connectionId,
        });
      }

      const zpl = extractZplFromCommonLabelResponse(data);

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="commonlabel_${cargoTrackingNumber}.zpl"`,
      );
      return res.status(200).send(zpl);
    }),
  );

  // -----------------
  // Invoice link: send + delete
  // -----------------
  app.post(
    "/v1/sprint11/invoices/link",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = SendInvoiceLinkSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const dryRun = parseBool(req.query.dryRun);
      const { connectionId, ...bodyRaw } = parsed.data;

      const body = {
        ...bodyRaw,
        // PDF expects invoiceDateTime in seconds (10 digits) and invoiceNumber in a strict format.
        invoiceDateTime: normalizeInvoiceDateTimeSeconds(bodyRaw.invoiceDateTime),
        invoiceNumber: normalizeInvoiceNumber(bodyRaw.invoiceNumber, String(bodyRaw.shipmentPackageId)),
      };

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg } = loaded as any;

      if (dryRun) return res.json({ ok: true, dryRun: true, wouldCall: "sendInvoiceLink", body });

      const out = await trendyolSendInvoiceLink(cfg, body);
      return res.status(201).json({ ok: true, result: out });
    }),
  );

  // Compatibility alias (older drafts)
  // POST /v1/sprint11/invoice/link/send?dryRun=1
  app.post(
    "/v1/sprint11/invoice/link/send",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = SendInvoiceLinkCompatSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const dryRun = parseBool(req.query.dryRun);
      const { connectionId, customerId: _ignored, ...bodyRaw } = parsed.data as any;

      const body = {
        ...bodyRaw,
        // PDF expects invoiceDateTime in seconds (10 digits) and invoiceNumber in a strict format.
        invoiceDateTime: normalizeInvoiceDateTimeSeconds(bodyRaw.invoiceDateTime),
        invoiceNumber: normalizeInvoiceNumber(bodyRaw.invoiceNumber, String(bodyRaw.shipmentPackageId)),
      };

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg } = loaded as any;

      if (dryRun) return res.json({ ok: true, alias: true, dryRun: true, wouldCall: "sendInvoiceLink", body });

      const out = await trendyolSendInvoiceLink(cfg, body);
      return res.status(201).json({ ok: true, alias: true, result: out });
    }),
  );

  app.post(
    "/v1/sprint11/invoices/link/delete",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = DeleteInvoiceLinkSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const dryRun = parseBool(req.query.dryRun);
      const { connectionId, ...body } = parsed.data;

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg } = loaded as any;

      if (dryRun) return res.json({ ok: true, dryRun: true, wouldCall: "deleteInvoiceLink", body });

      const out = await trendyolDeleteInvoiceLink(cfg, body);
      return res.status(202).json({ ok: true, result: out });
    }),
  );

  // -----------------
  // Public invoice file serving (for Trendyol invoiceLink)
  // -----------------
  app.get(
    "/v1/sprint11/public/invoices/:connectionId/:shipmentPackageId/:filename",
    asyncHandler(async (req: Request, res: Response) => {
      let connectionId: string;
      let shipmentPackageId: number;
      let filename: string;
      try {
        connectionId = safePathSegment(req.params.connectionId, "connectionId");
        shipmentPackageId = safePositiveInt(req.params.shipmentPackageId, "shipmentPackageId");
        filename = safePathSegment(req.params.filename, "filename");
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || String(e) });
      }

      const root = findRepoRoot();
      const dir = path.join(root, "outputs", "sprint11", "invoices", connectionId, String(shipmentPackageId));
      const fullPath = path.resolve(dir, filename);

      // Ensure resolved path stays within intended dir
      const dirResolved = path.resolve(dir) + path.sep;
      if (!fullPath.startsWith(dirResolved)) {
        return res.status(400).json({ error: "invalid_path" });
      }

      if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: "not_found", connectionId, shipmentPackageId, filename });
      }

      const ext = path.extname(fullPath).toLowerCase();
      if (ext === ".pdf") res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.sendFile(fullPath);
    }),
  );

  // -----------------
  // Invoice file publish: store locally and return a public invoiceLink
  // -----------------
  app.post(
    "/v1/sprint11/invoices/file/publish",
    express.raw({ type: "*/*", limit: "11mb" }),
    asyncHandler(async (req: Request, res: Response) => {
      let connectionId = String(req.query.connectionId ?? "").trim();
      let autopicked: any = null;
      if (!connectionId) {
        const pick = await pickDefaultTrendyolConnectionId();
        if ((pick as any).error) return res.status((pick as any).error.status).json((pick as any).error.body);
        connectionId = (pick as any).connectionId;
        autopicked = { connectionId, candidates: (pick as any).candidates };
      }

      const shipmentPackageIdRaw = req.query.shipmentPackageId ?? process.env.ECI_S11_SHIPMENT_PACKAGE_ID;
      const shipmentPackageId = Number(shipmentPackageIdRaw);
      const invoiceDateTimeRaw = req.query.invoiceDateTime != null ? Number(req.query.invoiceDateTime) : undefined;
      const invoiceNumberRaw = req.query.invoiceNumber != null ? String(req.query.invoiceNumber) : undefined;
      const dryRun = parseBool(req.query.dryRun);

      if (!Number.isFinite(shipmentPackageId) || shipmentPackageId <= 0) {
        return res.status(400).json({ error: "missing_or_invalid_shipmentPackageId" });
      }

      const buf = Buffer.isBuffer((req as any).body) ? ((req as any).body as Buffer) : Buffer.from([]);
      if (buf.length === 0) return res.status(400).json({ error: "missing_file_body" });
      if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: "file_too_large", max: "10MB" });

      const contentType = String(req.headers["content-type"] ?? "application/pdf");
      const filenameHeader = String(req.headers["x-filename"] ?? "invoice");
      const ext = inferExt(contentType, filenameHeader) || ".pdf";

      const invoiceDateTime = normalizeInvoiceDateTimeSeconds(invoiceDateTimeRaw);
      const invoiceNumber = normalizeInvoiceNumber(invoiceNumberRaw, String(shipmentPackageId));

      const root = findRepoRoot();
      const dir = path.join(root, "outputs", "sprint11", "invoices", connectionId, String(shipmentPackageId));
      ensureDir(dir);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const safeInv = invoiceNumber.replace(/[^a-zA-Z0-9]/g, "");
      const filename = `invoice_${shipmentPackageId}_${ts}_${safeInv}${ext}`;
      const fullPath = path.join(dir, filename);

      const meta = {
        publishedAt: new Date().toISOString(),
        connectionId,
        shipmentPackageId,
        invoiceDateTime,
        invoiceNumber,
        contentType,
        bytes: buf.length,
        sha256: sha256(buf),
        file: path.relative(root, fullPath).replace(/\\/g, "/"),
      };

      if (!dryRun) {
        fs.writeFileSync(fullPath, buf);
        fs.writeFileSync(path.join(dir, `${filename}.json`), JSON.stringify(meta, null, 2), "utf8");
      }

      const baseUrl = getPublicBaseUrl(req);
      const invoiceLink = `${baseUrl}/v1/sprint11/public/invoices/${connectionId}/${shipmentPackageId}/${filename}`;

      return res.status(200).json({
        ok: true,
        dryRun,
        ...(autopicked ? { autopicked } : {}),
        connectionId,
        shipmentPackageId,
        invoiceLink,
        stored: meta,
      });
    }),
  );

  // -----------------
  // Invoice submit: publish + seller-invoice-links + seller-invoice-file in ONE call
  // -----------------
  app.post(
    "/v1/sprint11/invoices/submit",
    express.raw({ type: "*/*", limit: "11mb" }),
    asyncHandler(async (req: Request, res: Response) => {
      let connectionId = String(req.query.connectionId ?? "").trim();
      let autopicked: any = null;
      if (!connectionId) {
        const pick = await pickDefaultTrendyolConnectionId();
        if ((pick as any).error) return res.status((pick as any).error.status).json((pick as any).error.body);
        connectionId = (pick as any).connectionId;
        autopicked = { connectionId, candidates: (pick as any).candidates };
      }

      const shipmentPackageIdRaw = req.query.shipmentPackageId ?? process.env.ECI_S11_SHIPMENT_PACKAGE_ID;
      const shipmentPackageId = Number(shipmentPackageIdRaw);
      const invoiceDateTimeRaw = req.query.invoiceDateTime != null ? Number(req.query.invoiceDateTime) : undefined;
      const invoiceNumberRaw = req.query.invoiceNumber != null ? String(req.query.invoiceNumber) : undefined;
      const dryRun = parseBool(req.query.dryRun);

      if (!Number.isFinite(shipmentPackageId) || shipmentPackageId <= 0) {
        return res.status(400).json({ error: "missing_or_invalid_shipmentPackageId" });
      }

      const buf = Buffer.isBuffer((req as any).body) ? ((req as any).body as Buffer) : Buffer.from([]);
      if (buf.length === 0) return res.status(400).json({ error: "missing_file_body" });
      if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: "file_too_large", max: "10MB" });

      const contentType = String(req.headers["content-type"] ?? "application/pdf");
      const filenameHeader = String(req.headers["x-filename"] ?? "invoice");
      const ext = inferExt(contentType, filenameHeader) || ".pdf";

      const invoiceDateTime = normalizeInvoiceDateTimeSeconds(invoiceDateTimeRaw);
      const invoiceNumber = normalizeInvoiceNumber(invoiceNumberRaw, String(shipmentPackageId));

      const root = findRepoRoot();
      const dir = path.join(root, "outputs", "sprint11", "invoices", connectionId, String(shipmentPackageId));
      ensureDir(dir);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const safeInv = invoiceNumber.replace(/[^a-zA-Z0-9]/g, "");
      const filename = `invoice_${shipmentPackageId}_${ts}_${safeInv}${ext}`;
      const fullPath = path.join(dir, filename);

      const meta = {
        savedAt: new Date().toISOString(),
        connectionId,
        shipmentPackageId,
        invoiceDateTime,
        invoiceNumber,
        contentType,
        bytes: buf.length,
        sha256: sha256(buf),
        file: path.relative(root, fullPath).replace(/\\/g, "/"),
      };

      // Always store locally so invoiceLink is real and testable.
      fs.writeFileSync(fullPath, buf);
      fs.writeFileSync(path.join(dir, `${filename}.json`), JSON.stringify(meta, null, 2), "utf8");

      const baseUrl = getPublicBaseUrl(req);
      const invoiceLink = `${baseUrl}/v1/sprint11/public/invoices/${connectionId}/${shipmentPackageId}/${filename}`;

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg } = loaded as any;

      const payload = { shipmentPackageId, invoiceNumber, invoiceDateTime, invoiceLink };

      if (dryRun) {
        return res.status(200).json({
          ok: true,
          dryRun: true,
          ...(autopicked ? { autopicked } : {}),
          connectionId,
          invoiceLink,
          stored: meta,
          wouldCall: {
            sendInvoiceLink: payload,
            sellerInvoiceFile: { shipmentPackageId, invoiceNumber, invoiceDateTime, contentType, filename, bytes: buf.length },
          },
        });
      }

      const recover409 = req.query.recover409 == null ? true : parseBool(req.query.recover409);

      let sent: any = null;
      let invoiceLinkAlreadyExists = false;
      let invoiceLinkRecovery: any = null;

      try {
        sent = await trendyolSendInvoiceLink(cfg, payload);
      } catch (e: any) {
        const message = String(e?.message || e);
        const upstreamStatus = parseUpstreamStatusFromErrorMessage(message);

        // Trendyol.pdf: seller-invoice-links may return 409. Typical recovery:
        // 1) resolve customerId from shipment packages
        // 2) POST seller-invoice-links/delete (serviceSourceId=shipmentPackageId, channelId=1, customerId)
        // 3) retry seller-invoice-links
        if (upstreamStatus === 409) {
          invoiceLinkAlreadyExists = true;

          if (!recover409) {
            sent = { ok: true, idempotent: true, upstreamStatus, note: "seller-invoice-links 409 treated as idempotent (recover409=0)" };
          } else {
            const resolved = await resolveCustomerIdForShipmentPackage(cfg, shipmentPackageId, 90);

            if (!resolved.ok || !resolved.customerId) {
              invoiceLinkRecovery = {
                ok: false,
                upstreamStatus,
                message,
                action: "skip_delete_no_customerId",
                resolved,
                note: "customerId bulunamadigi icin delete yapilamadi; 409 idempotent kabul edilip akisa devam edildi",
              };
              sent = { ok: true, idempotent: true, upstreamStatus, note: "seller-invoice-links 409 (customerId not found for delete)" };
            } else {
              let deleted: any = null;
              let deleteError: any = null;
              try {
                deleted = await trendyolDeleteInvoiceLink(cfg, {
                  serviceSourceId: shipmentPackageId,
                  channelId: 1,
                  customerId: resolved.customerId,
                });
              } catch (delErr: any) {
                deleteError = delErr?.message || String(delErr);
              }

              // allow Trendyol to propagate delete
              await sleep(600);

              try {
                sent = await trendyolSendInvoiceLink(cfg, payload);
                invoiceLinkRecovery = {
                  ok: true,
                  upstreamStatus,
                  firstError: { upstreamStatus, message },
                  delete: { ok: !deleteError, result: deleted, error: deleteError },
                  resolved: { customerId: resolved.customerId, cargoTrackingNumber: resolved.cargoTrackingNumber, sourceAttempts: resolved.attempts?.slice?.(0, 6) ?? [] },
                  note: "409 -> delete -> retry basarili",
                };
              } catch (e2: any) {
                const message2 = String(e2?.message || e2);
                const upstreamStatus2 = parseUpstreamStatusFromErrorMessage(message2);

                // If retry is still 409, treat as idempotent so we can still upload invoice file.
                if (upstreamStatus2 === 409) {
                  sent = { ok: true, idempotent: true, upstreamStatus: upstreamStatus2, note: "seller-invoice-links 409 after delete/retry treated as idempotent" };
                  invoiceLinkRecovery = {
                    ok: false,
                    upstreamStatus: upstreamStatus2,
                    firstError: { upstreamStatus, message },
                    secondError: { upstreamStatus: upstreamStatus2, message: message2 },
                    delete: { ok: !deleteError, result: deleted, error: deleteError },
                    resolved: { customerId: resolved.customerId, cargoTrackingNumber: resolved.cargoTrackingNumber },
                    note: "delete/retry denendi ama 409 devam ediyor; akisa idempotent olarak devam edildi",
                  };
                } else {
                  throw e2;
                }
              }
            }
          }
        } else {
          throw e;
        }
      }

      const uploaded = await trendyolUploadSellerInvoiceFile(cfg, {
        shipmentPackageId,
        invoiceNumber,
        invoiceDateTime,
        file: { buffer: buf, contentType, filename },
      });

      return res.status(200).json({
        ok: true,
        ...(autopicked ? { autopicked } : {}),
        connectionId,
        invoiceLink,
        stored: meta,
        result: { sellerInvoiceLinks: sent, sellerInvoiceFile: uploaded },
        invoiceLinkAlreadyExists,
        ...(invoiceLinkRecovery ? { invoiceLinkRecovery } : {}),
      });
    }),
  );


  // -----------------
  // Invoice file: RAW upload proxy + local storage
  // -----------------
  app.post(
    "/v1/sprint11/invoices/file/raw",
    // NOTE: express.json middleware won't parse non-json bodies. We explicitly grab raw bytes.
    express.raw({ type: "*/*", limit: "11mb" }),
    asyncHandler(async (req: Request, res: Response) => {
      const connectionId = String(req.query.connectionId ?? "").trim();
      const shipmentPackageId = Number(req.query.shipmentPackageId);
      const invoiceDateTimeRaw = req.query.invoiceDateTime != null ? Number(req.query.invoiceDateTime) : undefined;
      const invoiceNumberRaw = req.query.invoiceNumber != null ? String(req.query.invoiceNumber) : undefined;
      const dryRun = parseBool(req.query.dryRun);

      if (!connectionId) return res.status(400).json({ error: "missing_connectionId" });
      if (!Number.isFinite(shipmentPackageId) || shipmentPackageId <= 0)
        return res.status(400).json({ error: "missing_or_invalid_shipmentPackageId" });

      const buf = Buffer.isBuffer((req as any).body) ? ((req as any).body as Buffer) : Buffer.from([]);
      if (buf.length === 0) return res.status(400).json({ error: "missing_file_body" });
      if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: "file_too_large", max: "10MB" });

      const contentType = String(req.headers["content-type"] ?? "application/octet-stream");
      const filenameHeader = String(req.headers["x-filename"] ?? "invoice");
      const ext = inferExt(contentType, filenameHeader);

      // local storage
      const root = findRepoRoot();
      const dir = path.join(root, "outputs", "sprint11", "invoices", connectionId, String(shipmentPackageId));
      ensureDir(dir);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `invoice_${shipmentPackageId}_${ts}${ext || ""}`;
      const fullPath = path.join(dir, filename);
      fs.writeFileSync(fullPath, buf);

      const meta = {
        savedAt: new Date().toISOString(),
        connectionId,
        shipmentPackageId,
        invoiceDateTime: invoiceDateTimeRaw ?? null,
        invoiceNumber: invoiceNumberRaw ?? null,
        contentType,
        bytes: buf.length,
        sha256: sha256(buf),
        file: path.relative(root, fullPath).replace(/\\/g, "/"),
      };
      fs.writeFileSync(path.join(dir, `${filename}.json`), JSON.stringify(meta, null, 2), "utf8");

      const loaded = await loadTrendyolCfg(connectionId);
      if ((loaded as any).error) return res.status((loaded as any).error.status).json((loaded as any).error.body);
      const { cfg } = loaded as any;

      // If caller didn't provide invoice fields, auto-fill with PDF-compliant defaults.
      // (These are required by Trendyol seller-invoice-file in practice.)
      const invoiceDateTime = normalizeInvoiceDateTimeSeconds(invoiceDateTimeRaw);
      const invoiceNumber = normalizeInvoiceNumber(invoiceNumberRaw, String(shipmentPackageId));

      if (dryRun) {
        return res.json({ ok: true, dryRun: true, stored: meta, wouldCall: "sellerInvoiceFile" });
      }

      const out = await trendyolUploadSellerInvoiceFile(cfg, {
        shipmentPackageId,
        invoiceDateTime,
        invoiceNumber,
        file: {
          buffer: buf,
          filename: filenameHeader + (ext || ""),
          contentType,
        },
      });

      return res.status(200).json({ ok: true, stored: meta, result: out });
    }),
  );
}
