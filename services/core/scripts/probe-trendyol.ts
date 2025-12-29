import { normalizeConfig, trendyolProbeShipmentPackages } from "../src/eci/connectors/trendyol/client";

async function main() {
  const cfg = normalizeConfig({
    sellerId: process.env.TRENDYOL_SELLER_ID!,
    env: (process.env.TRENDYOL_ENV as any) || "prod",
    apiKey: process.env.TRENDYOL_API_KEY,
    apiSecret: process.env.TRENDYOL_API_SECRET,
    token: process.env.TRENDYOL_TOKEN,
    agentName: process.env.TRENDYOL_AGENT_NAME || "SoXYZ",
    integrationName: process.env.TRENDYOL_INTEGRATION_NAME || "SoXYZ-ECI",
    probeLegacy: process.env.TRENDYOL_PROBE_LEGACY === "1",
  });

  const res = await trendyolProbeShipmentPackages(cfg);
  console.log(JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
