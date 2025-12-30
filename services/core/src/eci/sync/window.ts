export type SyncWindowCfg = {
  lastSuccessAt?: Date | null;
  nowMs?: number;
  overlapMinutes: number;
  safetyDelayMinutes: number;
  bootstrapHours: number;
  maxWindowDays: number;
};

/**
 * Computes an incremental sync window.
 * - If lastSuccessAt exists: start = lastSuccessAt - overlap
 * - Else: start = now - bootstrapHours
 * - end = now - safetyDelay
 * Clamped to maxWindowDays.
 */
export function computeSyncWindow(cfg: SyncWindowCfg) {
  const now = cfg.nowMs ?? Date.now();

  const overlapMs = cfg.overlapMinutes * 60_000;
  const safetyMs = cfg.safetyDelayMinutes * 60_000;
  const bootstrapMs = cfg.bootstrapHours * 60 * 60_000;
  const maxWindowMs = cfg.maxWindowDays * 24 * 60 * 60_000;

  const endMs = now - safetyMs;

  let startMs = cfg.lastSuccessAt
    ? cfg.lastSuccessAt.getTime() - overlapMs
    : now - bootstrapMs;

  // Clamp window to avoid excessive range
  if (endMs - startMs > maxWindowMs) startMs = endMs - maxWindowMs;

  // Ensure start < end
  if (startMs >= endMs) startMs = endMs - Math.min(5 * 60_000, maxWindowMs);

  return { startDate: startMs, endDate: endMs };
}
