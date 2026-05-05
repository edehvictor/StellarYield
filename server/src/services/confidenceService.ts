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

export type DecayCurve = "linear" | "exponential" | "stepwise";

export interface FreshnessPolicy {
  provider: string;
  metric: string;
  curve: DecayCurve;
  freshWindowMs: number;
  softStaleMs: number;
  hardStaleMs: number;
  decayK?: number;
}

export interface DecayedFreshnessResult {
  confidence: number;
  unusable: boolean;
}

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  provider: "default",
  metric: "apy",
  curve: "exponential",
  freshWindowMs: 60_000,
  softStaleMs: 10 * 60_000,
  hardStaleMs: 45 * 60_000,
  decayK: 3.5,
};

export function computeDecayedFreshnessConfidence(
  ageMs: number,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS_POLICY,
): DecayedFreshnessResult {
  if (ageMs <= policy.freshWindowMs) {
    return { confidence: 1, unusable: false };
  }
  if (ageMs >= policy.hardStaleMs) {
    return { confidence: 0, unusable: true };
  }

  const normalized = Math.max(
    0,
    Math.min(1, (ageMs - policy.freshWindowMs) / (policy.softStaleMs - policy.freshWindowMs || 1)),
  );

  let confidence = 1;
  if (policy.curve === "linear") {
    confidence = 1 - normalized;
  } else if (policy.curve === "stepwise") {
    confidence = normalized < 0.33 ? 0.85 : normalized < 0.66 ? 0.55 : 0.25;
  } else {
    const k = policy.decayK ?? 3.5;
    confidence = Math.exp(-k * normalized);
  }

  return {
    confidence: Math.max(0, Math.min(1, confidence)),
    unusable: ageMs >= policy.hardStaleMs,
  };
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

// ── Allocation Confidence Bands (#388) ─────────────────────────────────────

export interface AllocationBand {
  /** Asset or strategy identifier */
  assetId: string;
  /** Recommended allocation percentage (e.g., 25.0 = 25%) */
  recommendedAllocation: number;
  /** Lower bound of confidence band */
  lowerBound: number;
  /** Upper bound of confidence band */
  upperBound: number;
  /** Band width (upper - lower) */
  bandWidth: number;
  /** Confidence score underlying this band */
  confidenceScore: number;
  /** Volatility input used for band calculation */
  volatility: number;
  /** Disclaimer that bands don't guarantee execution or outcomes */
  disclaimer: string;
}

export interface AllocationConfidenceResult {
  bands: AllocationBand[];
  /** Total portfolio allocation */
  totalAllocation: number;
  /** Overall portfolio confidence */
  portfolioConfidence: number;
  /** Timestamp when calculated */
  calculatedAt: string;
  /** Interpretation guide for users */
  interpretation: string;
}

const ALLOCATION_BAND_DISCLAIMER = "Confidence bands represent estimation uncertainty, not guaranteed execution ranges or guaranteed outcomes. Actual allocations may vary based on market conditions.";

const ALLOCATION_BAND_INTERPRETATION = "Wider bands indicate higher uncertainty in the recommendation. Narrow bands suggest higher confidence. Bands are calculated using confidence scores and asset volatility. Always review caveats before making allocation decisions.";

/**
 * Calculate confidence band width based on confidence and volatility
 */
export function calculateBandWidth(
  confidenceScore: number,
  volatility: number,
  baseWidth: number = 5.0,
): number {
  // Band widens with lower confidence and higher volatility
  const confidenceFactor = 1 - confidenceScore; // 0 = high confidence, 1 = low
  const volatilityFactor = Math.min(volatility * 2, 1.0); // Cap at 1.0
  
  const width = baseWidth * (1 + confidenceFactor * 2 + volatilityFactor);
  return Math.round(width * 100) / 100;
}

/**
 * Compute allocation confidence bands for a set of recommendations
 */
export function computeAllocationBands(
  allocations: Array<{
    assetId: string;
    recommendedAllocation: number;
    confidenceScore: number;
    volatility: number;
  }>,
): AllocationConfidenceResult {
  const bands: AllocationBand[] = allocations.map((alloc) => {
    const bandWidth = calculateBandWidth(alloc.confidenceScore, alloc.volatility);
    const halfWidth = bandWidth / 2;
    
    const lowerBound = Math.max(0, alloc.recommendedAllocation - halfWidth);
    const upperBound = Math.min(100, alloc.recommendedAllocation + halfWidth);
    
    return {
      assetId: alloc.assetId,
      recommendedAllocation: alloc.recommendedAllocation,
      lowerBound: Math.round(lowerBound * 100) / 100,
      upperBound: Math.round(upperBound * 100) / 100,
      bandWidth: Math.round(bandWidth * 100) / 100,
      confidenceScore: alloc.confidenceScore,
      volatility: alloc.volatility,
      disclaimer: ALLOCATION_BAND_DISCLAIMER,
    };
  });
  
  const totalAllocation = bands.reduce((sum, band) => sum + band.recommendedAllocation, 0);
  const portfolioConfidence = bands.length > 0
    ? bands.reduce((sum, band) => sum + band.confidenceScore, 0) / bands.length
    : 0;
  
  return {
    bands,
    totalAllocation: Math.round(totalAllocation * 100) / 100,
    portfolioConfidence: Math.round(portfolioConfidence * 1000) / 1000,
    calculatedAt: new Date().toISOString(),
    interpretation: ALLOCATION_BAND_INTERPRETATION,
  };
}

/**
 * Get color for confidence band based on confidence level
 */
export function getBandColor(confidenceScore: number): string {
  if (confidenceScore >= 0.85) return "green";
  if (confidenceScore >= 0.65) return "lightgreen";
  if (confidenceScore >= 0.45) return "orange";
  if (confidenceScore >= 0.25) return "red";
  return "darkred";
}

/**
 * Format allocation band for display
 */
export function formatAllocationBand(band: AllocationBand): string {
  return `${band.recommendedAllocation.toFixed(1)}% (${band.lowerBound.toFixed(1)}% - ${band.upperBound.toFixed(1)}%)`;
}
