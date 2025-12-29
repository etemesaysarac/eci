async function trendyolGetOrders(cfg, opts = {}) {
  const sellerId = String(cfg.sellerId || cfg.supplierId);
  if (!sellerId) throw new Error("sellerId/supplierId missing in config");

  const baseUrlRaw = (cfg.baseUrl || "https://apigw.trendyol.com").replace(/\/+$/, "");
  const userAgent = cfg.userAgent || `${sellerId} - SelfIntegration`; // Trendyol’un istediği format

  // sapigw kullanıyorsan suppliers yolu, apigw kullanıyorsan integration yolu:
  let url;
  if (baseUrlRaw.includes("sapigw")) {
    url = `${baseUrlRaw}/suppliers/${sellerId}/orders`;
  } else {
    const root = baseUrlRaw.endsWith("/integration") ? baseUrlRaw : `${baseUrlRaw}/integration`;
    url = `${root}/order/sellers/${sellerId}/orders`;
  }

  // Worker’ın ürettiği URL’yi artık ekranda NET göreceksin:
  console.log("[trendyol] GET", url, "params=", {
    status: opts.status || "Created",
    page: opts.page ?? 0,
    size: opts.size ?? 50
  });

  const res = await axios.get(url, {
    headers: {
      Authorization: basicAuth(cfg.apiKey, cfg.apiSecret),
      "User-Agent": userAgent,
      Accept: "application/json"
    },
    params: {
      status: opts.status || "Created",
      page: opts.page ?? 0,
      size: opts.size ?? 50,
      // dokümanda önerilen sıralama (istersen kaldırabilirsin)
      orderByField: "PackageLastModifiedDate",
      orderByDirection: "DESC"
    },
    timeout: 30000
  });

  return res.data;
}
