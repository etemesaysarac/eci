Sprint 9 route'larını API'ye bağlamak için server.ts içine 2 satır ekle.

1) Import'lara ekle:
   import { registerSprint9ProductCatalogRoutes } from "./server.sprint9";

2) register çağrısına ekle (Sprint 8'den sonra önerilir):
   registerSprint9ProductCatalogRoutes(app);

Sonra API'yi restart et (npm run eci:api).