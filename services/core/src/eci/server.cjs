require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const { Queue } = require("bullmq");

const prisma = new PrismaClient();
const eciQueue = new Queue("eci-jobs", { connection: { url: process.env.REDIS_URL || "redis://localhost:6379" } });

function getKey() {
  const b64 = process.env.ECI_ENCRYPTION_KEY_BASE64;
  if (!b64) throw new Error("ECI_ENCRYPTION_KEY_BASE64 missing in .env");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("ECI_ENCRYPTION_KEY_BASE64 must be 32 bytes (base64)");
  return key;
}

function encryptJson(obj) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptJson(payloadB64) {
  const key = getKey();
  const buf = Buffer.from(payloadB64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString("utf8"));
}

function basicAuth(apiKey, apiSecret) {
  return "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
}

async function trendyolGetOrders(cfg, opts = {}) {
  const baseUrl = cfg.baseUrl || "https://api.trendyol.com/sapigw";
  const url = `${baseUrl}/suppliers/${cfg.supplierId}/orders`;

  const res = await axios.get(url, {
    headers: {
      Authorization: basicAuth(cfg.apiKey, cfg.apiSecret),
      "User-Agent": "ECI/0.0.2"
    },
    params: {
      status: opts.status || "Created",
      page: opts.page ?? 0,
      size: opts.size ?? 1
    },
    timeout: 30000
  });

  return res.data;
}

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.status(200).send("ECI Core OK"));
app.get("/health", (_req, res) => res.status(200).send("OK"));

app.post("/v1/connections", async (req, res) => {
  try {
    const body = req.body || {};
    if (body.type !== "trendyol") return res.status(400).json({ error: "type must be 'trendyol'" });
    if (!body.name) return res.status(400).json({ error: "name required" });
    if (!body.config?.supplierId || !body.config?.apiKey || !body.config?.apiSecret) {
      return res.status(400).json({ error: "config.supplierId/apiKey/apiSecret required" });
    }

    const configEnc = encryptJson(body.config);
    const row = await prisma.connection.create({
      data: { type: "trendyol", name: body.name, configEnc }
    });

    res.json({ id: row.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/v1/connections", async (_req, res) => {
  const rows = await prisma.connection.findMany({ orderBy: { createdAt: "desc" } });
  res.json(rows.map(r => ({ id: r.id, type: r.type, name: r.name, status: r.status, createdAt: r.createdAt })));
});

app.post("/v1/connections/:id/test", async (req, res) => {
  try {
    const id = req.params.id;
    const conn = await prisma.connection.findUnique({ where: { id } });
    if (!conn) return res.status(404).json({ error: "not_found" });

    const cfg = decryptJson(conn.configEnc);
    const data = await trendyolGetOrders(cfg, { page: 0, size: 1 });
    res.json({ ok: true, sample: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/v1/connections/:id/sync/orders", async (req, res) => {
  try {
    const id = req.params.id;
    const conn = await prisma.connection.findUnique({ where: { id } });
    if (!conn) return res.status(404).json({ error: "not_found" });

    const job = await prisma.job.create({
      data: { connectionId: id, type: "TRENDYOL_SYNC_ORDERS", status: "queued" }
    });

    await eciQueue.add("TRENDYOL_SYNC_ORDERS", { jobId: job.id, connectionId: id });
    res.json({ jobId: job.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/v1/jobs", async (req, res) => {
  const connectionId = String(req.query.connectionId || "");
  const rows = await prisma.job.findMany({
    where: connectionId ? { connectionId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 50
  });
  res.json(rows);
});

app.get("/v1/orders", async (req, res) => {
  const connectionId = String(req.query.connectionId || "");
  const rows = await prisma.order.findMany({
    where: connectionId ? { connectionId } : undefined,
    orderBy: { updatedAt: "desc" },
    take: 100
  });
  res.json(rows);
});

const port = Number(process.env.PORT || 3001);
const host = "127.0.0.1";

const server = app.listen(port, host, () => {
  console.log("[eci-core] pid =", process.pid);
  console.log(`[eci-core] listening on http://${host}:${port}`);
});

server.on("error", (e) => console.error("[server error]", e));