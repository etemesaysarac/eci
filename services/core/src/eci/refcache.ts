import IORedis from "ioredis";
import { prisma } from "./prisma";

export type RefCacheScope = "GLOBAL" | "CONNECTION";

type CacheRecord<T = any> = {
  id: string;
  provider: string;
  scope: RefCacheScope;
  connectionId?: string | null;
  resourceKey: string;
  payload: T;
  fetchedAt: Date;
  expiresAt: Date;
};

let ensured = false;

async function ensureTable() {
  if (ensured) return;

  // Safe, idempotent table creation (dev-friendly).
  // NOTE: Prisma/Postgres prepared statements cannot run multiple SQL commands at once,
  // so we execute each statement separately (still idempotent).
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ReferenceCache" (
        "id" TEXT PRIMARY KEY,
        "provider" TEXT NOT NULL,
        "scope" TEXT NOT NULL,
        "connectionId" TEXT,
        "resourceKey" TEXT NOT NULL,
        "payload" JSONB NOT NULL,
        "fetchedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "hitCount" INTEGER NOT NULL DEFAULT 0,
        "lastAccessedAt" TIMESTAMPTZ
      )
    `),
    prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReferenceCache_provider_scope_idx" ON "ReferenceCache" ("provider","scope")`),
    prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReferenceCache_expiresAt_idx" ON "ReferenceCache" ("expiresAt")`),
  ]);

  ensured = true;
}

function makeId(provider: string, scope: RefCacheScope, connectionId: string | null | undefined, resourceKey: string) {
  const cid = connectionId ? connectionId : "global";
  return `${provider}:${scope}:${cid}:${resourceKey}`;
}

function redisKey(id: string) {
  return `eci:refcache:${id}`;
}

function getRedis() {
  const url = process.env.REDIS_URL ?? "";
  if (!url) return null;
  try {
    return new IORedis(url, { maxRetriesPerRequest: null });
  } catch {
    return null;
  }
}

const redis = getRedis();

export async function refCacheGet<T = any>(provider: string, scope: RefCacheScope, connectionId: string | null | undefined, resourceKey: string): Promise<{ data: T; source: "redis" | "db" } | null> {
  await ensureTable();
  const id = makeId(provider, scope, connectionId, resourceKey);

  // 1) Redis
  if (redis) {
    const raw = await redis.get(redisKey(id));
    if (raw) {
      try {
        return { data: JSON.parse(raw) as T, source: "redis" };
      } catch {
        // ignore parse errors, fall back to DB
      }
    }
  }

  // 2) DB
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT "payload", "expiresAt" FROM "ReferenceCache" WHERE "id" = $1 LIMIT 1`,
    id
  );

  if (!rows?.length) return null;

  const expiresAt = new Date(rows[0].expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return null;

  const payload = rows[0].payload as T;

  // update hit counters (best-effort)
  prisma
    .$executeRawUnsafe(
      `UPDATE "ReferenceCache" SET "hitCount" = "hitCount" + 1, "lastAccessedAt" = NOW() WHERE "id" = $1`,
      id
    )
    .catch(() => void 0);

  if (redis) {
    const ttlSec = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    await redis.setex(redisKey(id), ttlSec, JSON.stringify(payload));
  }

  return { data: payload, source: "db" };
}

export async function refCacheSet<T = any>(
  provider: string,
  scope: RefCacheScope,
  connectionId: string | null | undefined,
  resourceKey: string,
  payload: T,
  ttlMs: number
): Promise<void> {
  await ensureTable();
  const id = makeId(provider, scope, connectionId, resourceKey);
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.$executeRawUnsafe(
    `
INSERT INTO "ReferenceCache" ("id","provider","scope","connectionId","resourceKey","payload","expiresAt")
VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
ON CONFLICT ("id") DO UPDATE SET
  "payload" = EXCLUDED."payload",
  "expiresAt" = EXCLUDED."expiresAt",
  "fetchedAt" = NOW()
`,
    id,
    provider,
    scope,
    connectionId ?? null,
    resourceKey,
    JSON.stringify(payload),
    expiresAt.toISOString()
  );

  if (redis) {
    const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
    await redis.setex(redisKey(id), ttlSec, JSON.stringify(payload));
  }
}

export async function refCacheGetOrSet<T = any>(opts: {
  provider: string;
  scope: RefCacheScope;
  connectionId?: string | null;
  resourceKey: string;
  ttlMs: number;
  fetcher: () => Promise<T>;
}): Promise<{ data: T; source: "redis" | "db" | "upstream" }> {
  const hit = await refCacheGet<T>(opts.provider, opts.scope, opts.connectionId ?? null, opts.resourceKey);
  if (hit) return { data: hit.data, source: hit.source };

  const data = await opts.fetcher();
  await refCacheSet(opts.provider, opts.scope, opts.connectionId ?? null, opts.resourceKey, data, opts.ttlMs);
  return { data, source: "upstream" };
}

export async function refCacheStatus(limit = 50) {
  await ensureTable();
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT "id","provider","scope","connectionId","resourceKey","fetchedAt","expiresAt","hitCount","lastAccessedAt"
     FROM "ReferenceCache"
     ORDER BY "lastAccessedAt" DESC NULLS LAST, "fetchedAt" DESC
     LIMIT $1`,
    limit
  );
  const total = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int AS n FROM "ReferenceCache"`);
  return { total: total?.[0]?.n ?? 0, rows };
}

export async function refCacheRefreshByPrefix(provider: string, prefix: string) {
  await ensureTable();
  const like = prefix.endsWith("%") ? prefix : `${prefix}%`;
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT "id" FROM "ReferenceCache" WHERE "provider" = $1 AND "resourceKey" LIKE $2`,
    provider,
    like
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "ReferenceCache" WHERE "provider" = $1 AND "resourceKey" LIKE $2`,
    provider,
    like
  );

  if (redis && rows?.length) {
    // best effort delete exact keys (no SCAN to keep it safe)
    const keys = rows.map((r) => redisKey(String(r.id)));
    await redis.del(...keys);
  }

  return { deleted: rows?.length ?? 0 };
}
