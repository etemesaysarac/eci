import "dotenv/config";
import { prisma } from "../src/eci/prisma";

/**
 * Prints the latest Trendyol connection as JSON.
 *
 * Why this exists:
 *  - Codebase historically used both "TRENDYOL" and "trendyol" in Connection.type.
 *  - Some environments may have non-"active" status values.
 *
 * Strategy:
 *  1) Prefer type ~= trendyol (case-insensitive) AND status ~= active
 *  2) Fallback to latest type ~= trendyol (any status)
 *  3) Fallback to latest Job of type TRENDYOL_SYNC_QNA_QUESTIONS (uses connectionId)
 */

function isActive(status?: string | null) {
  return String(status ?? "").toLowerCase() === "active";
}

async function main() {
  // 1/2) Trendyol connections (case-insensitive)
  const rows = await prisma.connection.findMany({
    where: {
      type: { equals: "trendyol", mode: "insensitive" },
    },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { id: true, name: true, type: true, status: true, updatedAt: true, createdAt: true },
  });

  let chosen = rows.find((r) => isActive(r.status)) ?? rows[0];
  let reason = chosen ? (isActive(chosen.status) ? "connection:active" : "connection:any_status") : "";

  // 3) Fallback via latest QnA job (if no connections matched)
  if (!chosen) {
    const lastJob = await prisma.job.findFirst({
      where: { type: "TRENDYOL_SYNC_QNA_QUESTIONS" },
      orderBy: { createdAt: "desc" },
      select: { id: true, connectionId: true, createdAt: true },
    });

    if (lastJob) {
      const conn = await prisma.connection.findUnique({
        where: { id: lastJob.connectionId },
        select: { id: true, name: true, type: true, status: true, updatedAt: true, createdAt: true },
      });
      if (conn) {
        chosen = conn;
        reason = `job:${lastJob.id}`;
        // Keep a breadcrumb in stderr (doesn't break ConvertFrom-Json)
        console.error(
          JSON.stringify({ note: "fallback_used", via: "job", jobId: lastJob.id, connectionId: lastJob.connectionId }, null, 2)
        );
      }
    }
  }

  if (!chosen) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: "no_trendyol_connection_found",
          hint: "Create a connection via POST /v1/connections, or run a Trendyol job once so we can detect connectionId.",
        },
        null,
        2
      )
    );
    process.exit(2);
  }

  // Warn (stderr) if not active; still return ok:true.
  if (!isActive(chosen.status)) {
    console.error(JSON.stringify({ note: "connection_status_not_active", status: chosen.status }, null, 2));
  }

  console.log(JSON.stringify({ ok: true, reason, connection: chosen }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 2));
  process.exit(1);
});
