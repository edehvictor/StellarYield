/**
 * Recommendation Confidence Score and Uncertainty Bands (#277)
 *
 * Computes a bounded [0, 1] confidence score for AI/ranking recommendations
 * based on four contributing factors:
 *   1. Data Freshness   — how recent the underlying yield data is
 *   2. Provider Agreement — how much providers agree on the yield figure
 *   3. Liquidity Quality — depth of liquidity backing the opportunity
 *   4. Model Completeness — whether all required inputs are present
 *
 * Confidence ≠ guarantee. The score is advisory only and must never be
 * presented as a guarantee of future returns.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConfidenceLabel = "Very Low" | "Low" | "Medium" | "High" | "Very High";

export interface ConfidenceFactors {
  /** 0–1: 1 = data fetched in the last 60 s; decays linearly to 0 at 10 min. */
  freshness: number;
  /** 0–1: 1 = all providers agree; 0 = only one source or high variance. */
  providerAgreement: number;
  /** 0–1: 1 = deep liquidity (> $1M TVL); 0 = very low liquidity. */
  liquidityQuality: number;
  /** 0–1: 1 = all model inputs present; 0 = no inputs. */
  modelCompleteness: number;
}

export interface ConfidenceScore {
  /** Weighted composite score [0, 1]. */
  score: number;
  label: ConfidenceLabel;
  /** ±half-width of the uncertainty band (e.g. score ± band). */
  uncertaintyBand: number;
  factors: ConfidenceFactors;
  /** Human-readable caveats based on the weakest factors. */
  caveats: string[];
}

// Factor weights (must sum to 1.0)
const WEIGHTS = {
  freshness: 0.30,
  providerAgreement: 0.25,
  liquidityQuality: 0.25,
  modelCompleteness: 0.20,
} as const;

/** Compute data freshness score from age in milliseconds. */
export function computeFreshnessScore(ageMs: number): number {
  const MAX_AGE_MS = 10 * 60 * 1_000; // 10 minutes
  const FRESH_MS = 60 * 1_000;         // 1 minute = perfect freshness
  if (ageMs <= FRESH_MS) return 1.0;
  if (ageMs >= MAX_AGE_MS) return 0.0;
  return 1.0 - (ageMs - FRESH_MS) / (MAX_AGE_MS - FRESH_MS);
}

/** Compute provider-agreement score from an array of yield values. */
export function computeProviderAgreement(yields: number[]): number {
  if (yields.length === 0) return 0;
  if (yields.length === 1) return 0.5; // single source → moderate confidence
  const mean = yields.reduce((a, b) => a + b, 0) / yields.length;
  if (mean === 0) return 0;
  const variance = yields.reduce((s, y) => s + (y - mean) ** 2, 0) / yields.length;
  const cv = Math.sqrt(variance) / mean; // coefficient of variation
  return Math.max(0, 1 - cv * 2); // cv of 0.5 → score 0
}

/** Compute liquidity quality score from TVL in USD. */
export function computeLiquidityScore(tvlUsd: number): number {
  const MIN_TVL = 10_000;
  const MAX_TVL = 1_000_000;
  if (tvlUsd <= 0) return 0;
  if (tvlUsd >= MAX_TVL) return 1.0;
  if (tvlUsd < MIN_TVL) return 0;
  return Math.log10(tvlUsd / MIN_TVL) / Math.log10(MAX_TVL / MIN_TVL);
}

/** Compute model completeness score from a set of present/missing keys. */
export function computeModelCompleteness(
  requiredFields: string[],
  presentFields: string[],
): number {
  if (requiredFields.length === 0) return 1.0;
  const present = new Set(presentFields);
  const found = requiredFields.filter((f) => present.has(f)).length;
  return found / requiredFields.length;
}

function labelFromScore(score: number): ConfidenceLabel {
  if (score >= 0.85) return "Very High";
  if (score >= 0.65) return "High";
  if (score >= 0.45) return "Medium";
  if (score >= 0.25) return "Low";
  return "Very Low";
}

function buildCaveats(factors: ConfidenceFactors): string[] {
  const caveats: string[] = [];
  if (factors.freshness < 0.5)
    caveats.push("Data may be stale — refresh for the most accurate view.");
  if (factors.providerAgreement < 0.5)
    caveats.push("Providers disagree significantly on this yield figure.");
  if (factors.liquidityQuality < 0.3)
    caveats.push("Low liquidity: slippage may reduce effective yield.");
  if (factors.modelCompleteness < 0.6)
    caveats.push("Some model inputs are missing; estimate is less reliable.");
  return caveats;
}

/**
 * Compute the full confidence score for a recommendation.
 *
 * @param factors Pre-computed factor scores [0, 1] each.
 */
export function computeConfidenceScore(
  factors: ConfidenceFactors,
): ConfidenceScore {
  // Clamp each factor to [0, 1]
  const f: ConfidenceFactors = {
    freshness: Math.max(0, Math.min(1, factors.freshness)),
    providerAgreement: Math.max(0, Math.min(1, factors.providerAgreement)),
    liquidityQuality: Math.max(0, Math.min(1, factors.liquidityQuality)),
    modelCompleteness: Math.max(0, Math.min(1, factors.modelCompleteness)),
  };

  const score =
    f.freshness * WEIGHTS.freshness +
    f.providerAgreement * WEIGHTS.providerAgreement +
    f.liquidityQuality * WEIGHTS.liquidityQuality +
    f.modelCompleteness * WEIGHTS.modelCompleteness;

  // Uncertainty band: widens as score drops
  const uncertaintyBand = Math.max(0.02, (1 - score) * 0.2);

  return {
    score: Math.round(score * 1000) / 1000,
    label: labelFromScore(score),
    uncertaintyBand: Math.round(uncertaintyBand * 1000) / 1000,
    factors: f,
    caveats: buildCaveats(f),
  };
}
