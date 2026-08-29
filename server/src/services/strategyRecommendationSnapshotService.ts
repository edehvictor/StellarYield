/**
 * Strategy Recommendation Explanation Snapshot Service (#1186)
 *
 * Captures a compact, stable snapshot of the inputs and explanation behind
 * each strategy recommendation so users and reviewers can see why a vault
 * was shown at a specific moment.
 *
 * Security: Sensitive user data (private keys, wallet addresses, PII) is
 * explicitly excluded from stored explanations.
 */

import type { DepositWizardInput, VaultRecommendation } from "./depositRecommendationService";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The scoring inputs used to rank a strategy.
 * Contains only non-sensitive market and profile data.
 */
export interface RecommendationScoringInputs {
  riskTolerance: string;
  timeHorizon: string;
  liquidityNeeds: string;
  drawdownProfile: string;
  strategyId: string;
  strategyName: string;
  apy: number;
  tvlUsd: number;
  riskScore: number;
  riskAdjustedYield: number;
  matchScore: number;
  rank: number;
}

/**
 * Compact explanation summary stored with each recommendation snapshot.
 * This is intentionally terse — full prose explanations come from the
 * VaultRecommendation.explanation field.
 */
export interface RecommendationExplanationSummary {
  headline: string;
  scoringFactors: string[];
  /** ISO timestamp when this snapshot was generated. */
  capturedAt: string;
  /** Snapshot version for forward-compatibility. */
  version: number;
}

/**
 * Full recommendation snapshot — persisted per recommendation.
 */
export interface RecommendationSnapshot {
  snapshotId: string;
  /** Opaque session/request ID (never a wallet address or PII). */
  sessionRef?: string;
  inputs: RecommendationScoringInputs;
  explanation: string;           // Full prose from buildExplanation
  explanationSummary: RecommendationExplanationSummary;
  capturedAt: string;
}

// ── Current snapshot schema version ─────────────────────────────────────────
const SNAPSHOT_VERSION = 1;

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildScoringInputs(
  input: DepositWizardInput,
  drawdownProfile: string,
  rec: VaultRecommendation,
): RecommendationScoringInputs {
  return {
    riskTolerance: input.riskTolerance,
    timeHorizon: input.timeHorizon,
    liquidityNeeds: input.liquidityNeeds,
    drawdownProfile,
    strategyId: rec.id,
    strategyName: rec.name,
    apy: rec.apy,
    tvlUsd: rec.tvlUsd,
    riskScore: rec.riskScore,
    riskAdjustedYield: rec.riskAdjustedYield,
    matchScore: rec.matchScore,
    rank: rec.rank,
  };
}

function buildScoringFactors(
  input: DepositWizardInput,
  rec: VaultRecommendation,
): string[] {
  const factors: string[] = [];

  factors.push(`risk_tolerance:${input.riskTolerance}`);
  factors.push(`time_horizon:${input.timeHorizon}`);
  factors.push(`liquidity_needs:${input.liquidityNeeds}`);
  factors.push(`rank:${rec.rank}`);
  factors.push(`risk_adjusted_yield:${rec.riskAdjustedYield.toFixed(4)}`);
  factors.push(`match_score:${rec.matchScore.toFixed(4)}`);

  if (input.riskTolerance === "conservative" && rec.riskScore <= 3) {
    factors.push("low_risk_alignment");
  } else if (input.riskTolerance === "aggressive" && rec.apy >= 10) {
    factors.push("high_apy_alignment");
  }

  if (input.liquidityNeeds === "high" && rec.tvlUsd >= 5_000_000) {
    factors.push("deep_liquidity");
  }

  return factors;
}

function buildHeadline(rec: VaultRecommendation, input: DepositWizardInput): string {
  if (rec.rank === 1) {
    return `Top pick for ${input.riskTolerance} profile: ${rec.name} (rank #1, match score ${rec.matchScore.toFixed(1)})`;
  }
  return `${rec.name} ranked #${rec.rank} for ${input.riskTolerance}/${input.timeHorizon} profile`;
}

function generateSnapshotId(strategyId: string, capturedAt: string): string {
  return `snap:${strategyId}:${new Date(capturedAt).getTime()}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Capture an explanation snapshot for a single recommendation.
 *
 * @param input         - The wizard inputs (risk tolerance, horizon, liquidity).
 * @param drawdownProfile - The resolved drawdown profile (no PII).
 * @param rec           - The ranked recommendation to snapshot.
 * @param sessionRef    - Optional opaque session reference (never a wallet address).
 */
export function captureRecommendationSnapshot(
  input: DepositWizardInput,
  drawdownProfile: string,
  rec: VaultRecommendation,
  sessionRef?: string,
): RecommendationSnapshot {
  const capturedAt = new Date().toISOString();

  const scoringInputs = buildScoringInputs(input, drawdownProfile, rec);
  const scoringFactors = buildScoringFactors(input, rec);
  const headline = buildHeadline(rec, input);

  const explanationSummary: RecommendationExplanationSummary = {
    headline,
    scoringFactors,
    capturedAt,
    version: SNAPSHOT_VERSION,
  };

  return {
    snapshotId: generateSnapshotId(rec.id, capturedAt),
    sessionRef,
    inputs: scoringInputs,
    explanation: rec.explanation,
    explanationSummary,
    capturedAt,
  };
}

/**
 * Capture snapshots for all recommendations in a result set.
 *
 * @param input          - Wizard inputs.
 * @param drawdownProfile - Resolved drawdown profile.
 * @param recommendations - Ranked recommendations array.
 * @param sessionRef     - Optional opaque session reference.
 */
export function captureAllRecommendationSnapshots(
  input: DepositWizardInput,
  drawdownProfile: string,
  recommendations: VaultRecommendation[],
  sessionRef?: string,
): RecommendationSnapshot[] {
  return recommendations.map((rec) =>
    captureRecommendationSnapshot(input, drawdownProfile, rec, sessionRef),
  );
}

/**
 * Validate that a snapshot contains no sensitive user data.
 * Returns a list of violation descriptions (empty = clean).
 */
export function auditSnapshotForSensitiveData(
  snapshot: RecommendationSnapshot,
): string[] {
  const violations: string[] = [];

  // Wallet addresses: G + 55 uppercase alphanumeric chars (Stellar format)
  const stellarAddressPattern = /G[A-Z0-9]{55}/;

  const serialized = JSON.stringify(snapshot);

  if (stellarAddressPattern.test(serialized)) {
    violations.push("Snapshot may contain a Stellar wallet address");
  }

  // Generic email-shaped strings
  if (/@[a-zA-Z0-9]+\.[a-zA-Z]{2,}/.test(serialized)) {
    violations.push("Snapshot may contain an email address");
  }

  return violations;
}
