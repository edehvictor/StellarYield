export const YIELD_SOURCE_STALE_THRESHOLD_MS = 5 * 60_000;

export type YieldSourceFreshness =
  | { status: "fresh"; ageMinutes: number }
  | { status: "stale"; ageMinutes: number }
  | { status: "unknown" };

export interface YieldSourceFreshnessInput {
  fetchedAt?: string;
  isStale?: boolean;
}

export function getYieldSourceFreshness(
  source: YieldSourceFreshnessInput,
  nowMs = Date.now(),
): YieldSourceFreshness {
  const fetchedAtMs = source.fetchedAt ? Date.parse(source.fetchedAt) : NaN;
  if (!Number.isFinite(fetchedAtMs) || fetchedAtMs > nowMs) {
    return { status: "unknown" };
  }

  const ageMs = nowMs - fetchedAtMs;
  const ageMinutes = Math.floor(ageMs / 60_000);
  return {
    status:
      source.isStale === true || ageMs > YIELD_SOURCE_STALE_THRESHOLD_MS
        ? "stale"
        : "fresh",
    ageMinutes,
  };
}
