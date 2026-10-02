/**
 * Source Health Service
 *
 * Computes per-feed confidence and freshness for individual APY data sources.
 * This allows callers to understand *which* source lowered the aggregate
 * confidence and *which* source is stale, rather than only seeing a single
 * blended number.
 */

export type FreshnessStatus = "fresh" | "soft-stale" | "hard-stale";

export interface SourceHealthInput {
  provider: string;
  apy: number;
  tvlUsd: number;
  /** ISO-8601 timestamp of when this provider's data was fetched. */
  fetchedAt: string;
}

export interface SourceHealthResult {
  /** Name of the data provider. */
  provider: string;
  /** Per-source confidence score [0, 1]. */
  confidence: number;
  /** Per-source freshness score [0, 1]. */
  freshness: number;
  /** Human-readable freshness status. */
  freshnessStatus: FreshnessStatus;
  /** Age of the data in milliseconds. */
  ageMs: number;
}

// Freshness thresholds (mirrors confidenceService defaults)
const FRESH_WINDOW_MS = 60_000;       // 1 minute — perfect freshness
const SOFT_STALE_MS = 10 * 60_000;    // 10 minutes — starts decaying
const HARD_STALE_MS = 45 * 60_000;    // 45 minutes — unusable

/**
 * Compute the freshness score for a single source based on its age.
 *
 * Returns a score in [0, 1] where:
 * - 1.0  = fetched within the last 60 s
 * - 0.0  = older than the hard-stale threshold
 * - linear interpolation in between
 */
export function computeSourceFreshness(ageMs: number): number {
  if (ageMs <= FRESH_WINDOW_MS) return 1.0;
  if (ageMs >= HARD_STALE_MS) return 0.0;
  return 1.0 - (ageMs - FRESH_WINDOW_MS) / (HARD_STALE_MS - FRESH_WINDOW_MS);
}

/**
 * Determine the freshness status label for a given age.
 */
export function getFreshnessStatus(ageMs: number): FreshnessStatus {
  if (ageMs <= SOFT_STALE_MS) return "fresh";
  if (ageMs <= HARD_STALE_MS) return "soft-stale";
  return "hard-stale";
}

/**
 * Compute a per-source confidence score.
 *
 * This is distinct from the aggregate confidence: it considers only this
 * source's own staleness and its deviation from the group mean.
 */
export function computeSourceConfidence(
  freshness: number,
  deviationFromMean: number,
  meanApy: number,
): number {
  // Freshness component (0.4 weight)
  const freshnessWeight = 0.4;
  // Agreement component (0.6 weight): penalise deviation from mean
  const absDeviation = Math.abs(deviationFromMean);
  const relativeDeviation = meanApy !== 0 ? absDeviation / Math.abs(meanApy) : absDeviation;
  // A relative deviation of 0 → score 1.0; 0.5 → score 0.0
  const agreementScore = Math.max(0, 1 - relativeDeviation * 2);

  return Math.round((freshness * freshnessWeight + agreementScore * (1 - freshnessWeight)) * 1000) / 1000;
}

/**
 * Compute health metrics for a single source given the group context.
 */
export function computeSourceHealth(
  input: SourceHealthInput,
  meanApy: number,
  now: Date = new Date(),
): SourceHealthResult {
  const fetchedAt = new Date(input.fetchedAt);
  const ageMs = Math.max(0, now.getTime() - fetchedAt.getTime());
  const freshness = computeSourceFreshness(ageMs);
  const freshnessStatus = getFreshnessStatus(ageMs);
  const deviationFromMean = input.apy - meanApy;
  const confidence = computeSourceConfidence(freshness, deviationFromMean, meanApy);

  return {
    provider: input.provider,
    confidence,
    freshness,
    freshnessStatus,
    ageMs,
  };
}

/**
 * Compute health for all sources in a provider set.
 *
 * @param inputs  Array of provider inputs.
 * @param now     Reference time (default: Date.now()). Useful for testing.
 */
export function computeAllSourceHealth(
  inputs: SourceHealthInput[],
  now: Date = new Date(),
): SourceHealthResult[] {
  if (inputs.length === 0) return [];

  const meanApy =
    inputs.reduce((sum, i) => sum + i.apy, 0) / inputs.length;

  return inputs.map((input) => computeSourceHealth(input, meanApy, now));
}
