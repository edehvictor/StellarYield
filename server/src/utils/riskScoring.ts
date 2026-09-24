/**
 * Algorithmic Pool Risk Scoring
 *
 * Generates a Risk Score (1–10) for a liquidity pool based on three
 * quantitative inputs:
 *
 *   • Total Value Locked (TVL)        — proxy for market confidence
 *   • Impermanent Loss Volatility (%) — historical IL volatility
 *   • Protocol Age (days)             — maturity indicator
 *
 * ## Formula
 *
 * Each input is normalised to a 0–10 sub-score, then combined with weights:
 *
 *   RiskScore = (w_tvl × TVL_score) + (w_vol × Volatility_score) + (w_age × Age_score)
 *
 * Where:
 *   w_tvl = 0.40  — TVL is the strongest signal of pool health
 *   w_vol = 0.35  — IL volatility directly impacts user returns
 *   w_age = 0.25  — older protocols have more battle-tested code
 *
 * High score = low risk.  Low score = high risk.
 */

// ── Weights ─────────────────────────────────────────────────────────────

const WEIGHT_TVL = 0.40;
const WEIGHT_VOLATILITY = 0.35;
const WEIGHT_AGE = 0.25;

// ── Sub-score helpers ───────────────────────────────────────────────────

/**
 * TVL sub-score (0–10).
 *
 * Uses a logarithmic curve so the first few million matter most:
 *   score = min(10, log10(tvl + 1) × 2)
 *
 * Reference points:
 *   $0        → 0.0
 *   $100k     → 10.0  (capped)
 *   $1M       → 10.0
 *   $10M      → 10.0
 */
export function tvlScore(tvlUsd: number): number {
  if (tvlUsd <= 0) return 0;
  return Math.min(10, Math.log10(tvlUsd + 1) * 2);
}

/**
 * IL Volatility sub-score (0–10).
 *
 * Inverted linear scale: lower volatility → higher score.
 *   score = max(0, 10 − volatilityPct)
 *
 * Reference points:
 *   0%   → 10
 *   5%   → 5
 *   10%+ → 0
 */
export function volatilityScore(volatilityPct: number): number {
  if (volatilityPct < 0) return 10;
  return Math.max(0, 10 - volatilityPct);
}

/**
 * Protocol Age sub-score (0–10).
 *
 * Diminishing returns curve:
 *   score = min(10, sqrt(ageDays) / sqrt(365) × 10)
 *
 * Reference points:
 *   0 days   → 0
 *   90 days  → ~5.0
 *   365 days → 10.0
 *   730 days → 10.0 (capped)
 */
export function ageScore(ageDays: number): number {
  if (ageDays <= 0) return 0;
  return Math.min(10, (Math.sqrt(ageDays) / Math.sqrt(365)) * 10);
}

// ── Main scoring function ───────────────────────────────────────────────

export interface RiskInput {
  /** Total Value Locked in USD */
  tvlUsd: number;
  /** Historical Impermanent Loss volatility in percent (0–100) */
  ilVolatilityPct: number;
  /** Protocol age in days */
  protocolAgeDays: number;
}

export interface RiskResult {
  /** Final risk score, 1 (highest risk) to 10 (lowest risk) */
  score: number;
  /** Human-readable label */
  label: "Low" | "Medium" | "High";
  /** Breakdown of individual sub-scores */
  breakdown: {
    tvl: number;
    volatility: number;
    age: number;
  };
  /** Oracle metadata (if oracle-based pricing is used) */
  oracleMetadata?: {
    source: "fresh" | "twap_fallback" | "unavailable";
    ageSeconds: number | null;
    confidence: number; // 0-100
    sampleCount?: number;
  };
}

/**
 * Calculate the risk score for a liquidity pool.
 *
 * @param input - Pool parameters
 * @returns Risk score (1–10), label, and sub-score breakdown
 *
 * @example
 * ```ts
 * const result = calculateRiskScore({
 *   tvlUsd: 12_000_000,
 *   ilVolatilityPct: 2.5,
 *   protocolAgeDays: 400,
 * });
 * // result.score ≈ 8.6  → "Low" risk
 * ```
 */
export function calculateRiskScore(input: RiskInput): RiskResult {
  const tvl = tvlScore(input.tvlUsd);
  const vol = volatilityScore(input.ilVolatilityPct);
  const age = ageScore(input.protocolAgeDays);

  const raw =
    WEIGHT_TVL * tvl +
    WEIGHT_VOLATILITY * vol +
    WEIGHT_AGE * age;

  // Clamp to [1, 10]
  const score = Math.round(Math.max(1, Math.min(10, raw)) * 10) / 10;

  const label: RiskResult["label"] =
    score >= 7 ? "Low" : score >= 4 ? "Medium" : "High";

  return {
    score,
    label,
    breakdown: {
      tvl: Math.round(tvl * 100) / 100,
      volatility: Math.round(vol * 100) / 100,
      age: Math.round(age * 100) / 100,
    },
  };
}

// ── #1416: Risk score explanation metadata ─────────────────────────────

/** Which direction a factor pushed the overall score. */
export type RiskFactorImpact = "driver" | "neutral" | "mitigant";

export interface RiskFactorExplanation {
  factor: "tvl" | "volatility" | "age";
  /** Raw input value this sub-score was computed from. */
  value: number;
  /** Normalised 0–10 sub-score (same values as `RiskResult.breakdown`). */
  subScore: number;
  /** Share of the final score this factor contributes, 0–1. */
  weight: number;
  /** "driver" pushes risk up (low sub-score), "mitigant" pushes it down (high sub-score). */
  impact: RiskFactorImpact;
  /** One-sentence, human-readable reason — safe to render directly in the UI. */
  reason: string;
}

export interface RiskScoreExplanation {
  score: number;
  label: RiskResult["label"];
  summary: string;
  factors: RiskFactorExplanation[];
}

const IMPACT_THRESHOLD = { driver: 4, mitigant: 7 } as const;

function impactFor(subScore: number): RiskFactorImpact {
  if (subScore < IMPACT_THRESHOLD.driver) return "driver";
  if (subScore >= IMPACT_THRESHOLD.mitigant) return "mitigant";
  return "neutral";
}

/**
 * Turns a `RiskResult` into a human-readable explanation: which factors
 * are driving the score up or down, and why, in plain language a
 * non-technical user can read next to the number.
 *
 * Pure function over an already-computed `RiskResult` + the original
 * `RiskInput` (needed for the raw values, which the breakdown alone
 * doesn't carry) — never re-derives the score, so it can't disagree with
 * `calculateRiskScore`'s own math.
 */
export function explainRiskScore(result: RiskResult, input: RiskInput): RiskScoreExplanation {
  const factors: RiskFactorExplanation[] = [
    {
      factor: "tvl",
      value: input.tvlUsd,
      subScore: result.breakdown.tvl,
      weight: WEIGHT_TVL,
      impact: impactFor(result.breakdown.tvl),
      reason:
        result.breakdown.tvl >= IMPACT_THRESHOLD.mitigant
          ? `Total value locked ($${formatUsd(input.tvlUsd)}) is high enough to signal strong market confidence.`
          : result.breakdown.tvl < IMPACT_THRESHOLD.driver
            ? `Total value locked ($${formatUsd(input.tvlUsd)}) is low, offering less depth and a thinner track record.`
            : `Total value locked ($${formatUsd(input.tvlUsd)}) is moderate — neither a strong signal nor a red flag.`,
    },
    {
      factor: "volatility",
      value: input.ilVolatilityPct,
      subScore: result.breakdown.volatility,
      weight: WEIGHT_VOLATILITY,
      impact: impactFor(result.breakdown.volatility),
      reason:
        result.breakdown.volatility >= IMPACT_THRESHOLD.mitigant
          ? `Historical impermanent-loss volatility (${input.ilVolatilityPct}%) is low, so returns have been relatively stable.`
          : result.breakdown.volatility < IMPACT_THRESHOLD.driver
            ? `Historical impermanent-loss volatility (${input.ilVolatilityPct}%) is high, which can erode returns unpredictably.`
            : `Historical impermanent-loss volatility (${input.ilVolatilityPct}%) is moderate.`,
    },
    {
      factor: "age",
      value: input.protocolAgeDays,
      subScore: result.breakdown.age,
      weight: WEIGHT_AGE,
      impact: impactFor(result.breakdown.age),
      reason:
        result.breakdown.age >= IMPACT_THRESHOLD.mitigant
          ? `The protocol has ${input.protocolAgeDays} days of live history, a meaningful track record.`
          : result.breakdown.age < IMPACT_THRESHOLD.driver
            ? `The protocol has only ${input.protocolAgeDays} days of live history, so it's largely untested.`
            : `The protocol has ${input.protocolAgeDays} days of live history — some track record, but still maturing.`,
    },
  ];

  const drivers = factors.filter((f) => f.impact === "driver").map((f) => f.factor);
  const mitigants = factors.filter((f) => f.impact === "mitigant").map((f) => f.factor);

  const summary =
    drivers.length === 0
      ? `${result.label} risk (${result.score}/10) — no single factor stands out as a major concern.`
      : `${result.label} risk (${result.score}/10), driven mainly by ${listJoin(drivers)}` +
        (mitigants.length > 0 ? `, partially offset by ${listJoin(mitigants)}.` : ".");

  return { score: result.score, label: result.label, summary, factors };
}

function listJoin(items: string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.max(0, value));
}

/**
 * Enhance risk result with oracle metadata for transparency.
 * 
 * @param result - Base risk result
 * @param metadata - Oracle metadata from contract
 * @returns Enhanced risk result with oracle information
 */
export function enhanceWithOracleMetadata(
  result: RiskResult,
  metadata: {
    source: "fresh" | "twap_fallback" | "unavailable";
    ageSeconds: number | null;
    confidence: number;
    sampleCount?: number;
  }
): RiskResult {
  return {
    ...result,
    oracleMetadata: metadata,
  };
}

/**
 * Determine if oracle confidence meets minimum threshold for sensitive operations.
 * 
 * @param confidence - Oracle confidence score (0-100)
 * @param operationType - Type of operation being performed
 * @returns Whether the operation should be allowed
 */
export function isOracleConfidenceSufficient(
  confidence: number,
  operationType: "deposit" | "withdraw" | "rebalance" | "liquidation"
): boolean {
  const thresholds = {
    deposit: 60,      // Medium confidence acceptable for deposits
    withdraw: 60,     // Medium confidence acceptable for withdrawals
    rebalance: 75,    // Higher confidence required for rebalances
    liquidation: 85,  // Highest confidence required for liquidations
  };

  return confidence >= thresholds[operationType];
}
