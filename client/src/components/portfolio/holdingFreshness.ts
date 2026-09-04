/**
 * Client-side holding freshness classification (#1107).
 *
 * Mirrors server/src/services/sourceHealthService.ts so the portfolio
 * view and any exported report always agree on the same three states:
 *   - "fresh"   — fetched within the fresh window
 *   - "stale"   — fetched, but longer ago than the fresh window
 *   - "unknown" — no fetch timestamp available at all
 */

export type FreshnessStatus = "fresh" | "stale" | "unknown";

export interface FreshnessResult {
  status: FreshnessStatus;
  /** Age of the data in seconds, or null when fetchedAt is unknown. */
  ageSeconds: number | null;
}

/** 5 minutes — matches server/src/services/sourceHealthService.ts's default. */
export const FRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Classify a holding's source-data freshness from its last-fetched
 * timestamp.
 *
 * @param fetchedAt ISO-8601 timestamp of the last successful fetch, or
 *   null/undefined if the source has never reported one.
 * @param now Reference "current" time (defaults to `new Date()`).
 */
export function computeHoldingFreshness(
  fetchedAt: string | null | undefined,
  now: Date = new Date(),
): FreshnessResult {
  if (!fetchedAt) {
    return { status: "unknown", ageSeconds: null };
  }

  const parsed = new Date(fetchedAt);
  if (Number.isNaN(parsed.getTime())) {
    return { status: "unknown", ageSeconds: null };
  }

  const ageMs = now.getTime() - parsed.getTime();
  const ageSeconds = Math.max(0, Math.round(ageMs / 1000));
  const status: FreshnessStatus = ageMs <= FRESH_WINDOW_MS ? "fresh" : "stale";

  return { status, ageSeconds };
}

/** Human-friendly "time since fetched" label, or null when age is unknown. */
export function formatFreshnessAge(ageSeconds: number | null | undefined): string | null {
  if (ageSeconds === null || ageSeconds === undefined || !Number.isFinite(ageSeconds)) {
    return null;
  }
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s ago`;
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}