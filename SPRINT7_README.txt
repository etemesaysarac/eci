SPRINT 7 — Trendyol Order Actions (Bundle)
=========================================

This bundle DOES NOT overwrite your existing server.ts.
Instead it adds:
  - server.sprint7.ts (registerSprint7ActionRoutes)
  - trendyol/actions.ts (HTTP callers)
  - schema.prisma snippet (ShipmentPackageAction model)

Apply:
1) Unzip on top of repo:
   Expand-Archive -Force -Path .\sprint7_bundle.zip -DestinationPath C:\dev\eci

2) Add the Prisma model:
   Open services/core/prisma/schema.prisma
   Append the model from this bundle (services/core/prisma/schema.prisma)
   Then run:
     cd C:\dev\eci\services\core
     npx prisma db push --skip-generate
     npx prisma generate

3) Wire routes in your REAL server bootstrap (where app is created):
   import { registerSprint7ActionRoutes } from "./eci/server.sprint7";
   registerSprint7ActionRoutes(app);

4) ENV required:
   TRENDYOL_BASE_URL=https://api.trendyol.com/sapigw
   TRENDYOL_SELLER_ID=...
   TRENDYOL_API_KEY=...
   TRENDYOL_API_SECRET=...

Test:
  $cid="YOUR_CONNECTION_ID"
  $pid="3498035521"
  $body = @{ trackingNumber="ABC123456TR" } | ConvertTo-Json
  Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:3001/v1/connections/$cid/shipment-packages/$pid/actions/update-tracking-number" -ContentType "application/json" -Body $body

Audit:
  docker exec -it infra-postgres-1 psql -U eci -d eci -c "select action_type,status,created_at from shipment_package_action order by created_at desc limit 20;"
