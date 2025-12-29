// CommonJS: node scripts/mock-trendyol.js
const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3999);

// Basit rate limit: 5 sn içinde 8 isteği geçerse 429
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 8;
let hits = [];

function now() { return Date.now(); }
function pruneHits() {
  const t = now();
  hits = hits.filter(x => (t - x) < RATE_WINDOW_MS);
}

function json(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function makePkg(i, status, lastModified) {
  const baseId = 90000000 + i;
  return {
    id: baseId, // shipmentPackageId gibi düşünebilirsin
    orderNumber: String(1500000000 + i),
    status,
    shipmentPackageStatus: "ReadyToShip",
    lastModifiedDate: lastModified,
    orderDate: lastModified - 3600_000,
    cargoTrackingNumber: 2200000000 + i,
    cargoProviderName: "MOCK_CARGO",
    lines: [
      {
        id: 8000000 + i,
        merchantSku: `MOCK-SKU-${i}`,
        barcode: `MOCK-BC-${i}`,
        productName: `Mock Product ${i}`,
        quantity: 1,
        price: 100.0,
        currencyCode: "TRY",
        orderLineItemStatusName: "ReadyToShip",
      },
    ],
    packageHistories: [{ createdDate: lastModified - 10_000, status }],
  };
}

function handleOrders(req, res, u) {
  pruneHits();
  hits.push(now());
  if (hits.length > RATE_MAX || u.searchParams.get("force429") === "1") {
    return json(res, 429, { ok: false, error: "rate_limited" }, { "Retry-After": "2" });
  }

  const page = Number(u.searchParams.get("page") || 0);
  const size = Number(u.searchParams.get("size") || 50);
  const status = u.searchParams.get("status") || "Created";

  const startDate = Number(u.searchParams.get("startDate") || (now() - 24*3600*1000));
  const endDate = Number(u.searchParams.get("endDate") || now());
  const windowMs = Math.max(0, endDate - startDate);

  // Window'a göre totalElements üretelim:
  // 24 saat -> 3 kayıt (tek sayfa), 7 gün -> 120 kayıt (çok sayfa)
  const totalElements = windowMs <= 24*3600*1000 ? 3 : 120;
  const totalPages = Math.max(1, Math.ceil(totalElements / size));

  const startIdx = page * size;
  const endIdx = Math.min(totalElements, startIdx + size);

  const content = [];
  for (let i = startIdx; i < endIdx; i++) {
    content.push(makePkg(i + 1, status, endDate - (i * 60_000)));
  }

  return json(res, 200, { totalElements, totalPages, page, size, content });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  // health
  if (u.pathname === "/health") return json(res, 200, { ok: true });

  // Biz her ihtimale karşı iki prefix’i de kabul edelim:
  // /integration/...
  // /sapigw/integration/...
  const p = u.pathname;

  const isOrders =
    p.includes("/integration/order/sellers/") && p.endsWith("/orders");

  if (req.method === "GET" && isOrders) return handleOrders(req, res, u);

  // yanlış endpoint'e giderse net konuşsun:
  return json(res, 404, { ok: false, error: "not_found", path: u.pathname });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-trendyol] listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-trendyol] GET  /integration/order/sellers/:id/orders?page=0&size=50&status=Created&startDate=...&endDate=...`);
});
