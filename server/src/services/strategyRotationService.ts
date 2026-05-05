import {
  computeConfidenceScore,
  computeDecayedFreshnessConfidence,
  type ConfidenceFactors,
  type ConfidenceScore,
} from "./confidenceService";

/**
 * Autonomous Strategy Rotation Service
 *
 * Evaluates strategy performance on a fixed cadence and rotates capital
 * into stronger strategies when target conditions are met.
 *
 * Rotation policy:
 *   1. Candidate must outperform the current strategy by at least
 *      `minScoreDifference` (e.g. 0.5 risk-adjusted yield points).
 *   2. The current strategy must not be inside its rotation `cooldownMs`
 *      (e.g. 24h). If we just rotated into it, we hold.
 *   3. Candidate's data must be fresh (within `maxDataAgeMs`); stale data
 *      always defers rotation to avoid acting on noisy signals.
 *   4. Candidate's signal `confidence` must meet `minConfidence` (where
 *      provided). This prevents acting on degraded provider data.
 *   5. If multiple candidates clear the bar, the highest-score candidate
 *      wins. Ties resolve to the candidate with the higher confidence,
 *      then to the lower volatility, then alphabetically by id for
 *      determinism.
 *
 * The service NEVER mutates external state — callers receive a structured
 * `RotationDecision` and are responsible for executing or recording it.
 *
 * Decisions are emitted for both rotations AND no-ops, so consumers can
 * audit *why* the scheduler chose to hold.
 */

export interface RotationCandidate {
  id: string;
  name: string;
  /** Risk-adjusted score (higher = stronger). */
  score: number;
  /** Optional ilVolatility-style stability proxy. Lower = more stable. */
  volatility?: number;
  /** Confidence in [0,1]. Defaults to 1 when missing. */
  confidence?: number;
  /**
   * Optional factor hints used to render a confidence decomposition.
   * If omitted, the service will estimate factors from what it has.
   */
  confidenceFactors?: Partial<ConfidenceFactors>;
  /** ISO-8601 timestamp of when the score was computed. */
  fetchedAt: string;
}

export interface RotationPolicy {
  /** Minimum score lead the candidate must have over the incumbent. */
  minScoreDifference: number;
  /** How long after rotating into a strategy we are willing to leave it. */
  cooldownMs: number;
  /** Maximum acceptable data age. Stale candidates are skipped. */
  maxDataAgeMs: number;
  /** Minimum candidate confidence in [0,1]. */
  minConfidence: number;
}

export const DEFAULT_ROTATION_POLICY: RotationPolicy = {
  minScoreDifference: 0.5,
  cooldownMs: 24 * 60 * 60 * 1000,
  maxDataAgeMs: 10 * 60 * 1000,
  minConfidence: 0.7,
};

export type RotationAction = "rotate" | "hold";

export type RotationReason =
  | "no_candidates"
  | "no_current_strategy"
  | "current_in_cooldown"
  | "candidate_data_stale"
  | "candidate_low_confidence"
  | "candidate_below_threshold"
  | "candidate_better"
  | "current_unchanged";

export interface RotationDecision {
  action: RotationAction;
  reason: RotationReason;
  /** Identifier of the incumbent strategy at decision time. */
  fromId: string | null;
  /** Identifier of the candidate winning rotation, if any. */
  toId: string | null;
  /** Score delta = candidate.score - currentScore (when applicable). */
  scoreDelta: number | null;
  /** Human-readable detail safe to surface to operators. */
  detail: string;
  /**
   * Confidence decomposition for the winning candidate.
   * Present only when `action === "rotate"` and a candidate was selected.
   */
  confidenceBreakdown?: ConfidenceScore;
  /**
   * Interprets how “close” the winner was to the min confidence bar.
   * Present only when `confidenceBreakdown` exists.
   */
  confidenceStrength?: "borderline" | "strongly_favored";
  /**
   * Short list of driver strings explaining the borderline/strongly-favored
   * interpretation (safe for UI; no secrets).
   */
  confidenceWhy?: string[];
  /** ISO-8601 decision timestamp. */
  evaluatedAt: string;
}

export interface RotationContext {
  /** Current strategy's id (the incumbent), or null if none allocated yet. */
  currentId: string | null;
  /** Current strategy's score for the same metric used for candidates. */
  currentScore: number | null;
  /** When the current strategy was last rotated into, if known. */
  lastRotatedAt: string | null;
  /** Available candidates including (optionally) the incumbent itself. */
  candidates: RotationCandidate[];
}

/**
 * Pure function: given a context and policy, return the rotation decision.
 */
export function evaluateRotation(
  context: RotationContext,
  policy: RotationPolicy = DEFAULT_ROTATION_POLICY,
  now: number = Date.now(),
): RotationDecision {
  const ts = new Date(now).toISOString();

  if (!context.candidates.length) {
    return {
      action: "hold",
      reason: "no_candidates",
      fromId: context.currentId,
      toId: null,
      scoreDelta: null,
      detail: "No candidates were supplied to the rotation evaluator.",
      evaluatedAt: ts,
    };
  }

  // Cooldown check is independent of candidate quality: if we are inside
  // the cooldown window we hold regardless of how attractive a candidate
  // looks. This prevents churn under noisy / fast-moving signals.
  if (
    context.currentId &&
    context.lastRotatedAt &&
    Number.isFinite(Date.parse(context.lastRotatedAt))
  ) {
    const sinceRotation = now - Date.parse(context.lastRotatedAt);
    if (sinceRotation < policy.cooldownMs) {
      return {
        action: "hold",
        reason: "current_in_cooldown",
        fromId: context.currentId,
        toId: null,
        scoreDelta: null,
        detail: `Cooldown active: ${sinceRotation}ms since last rotation < ${policy.cooldownMs}ms.`,
        evaluatedAt: ts,
      };
    }
  }

  // Filter out the incumbent and disqualified candidates BEFORE picking
  // the best. We keep an explicit reason for the first reject so the
  // decision log is informative even when nothing rotates.
  let firstSkipReason: RotationReason = "candidate_below_threshold";
  let firstSkipDetail = "";
  const eligible: RotationCandidate[] = [];

  for (const candidate of context.candidates) {
    if (candidate.id === context.currentId) continue;

    const ageMs = now - Date.parse(candidate.fetchedAt);
    if (!Number.isFinite(ageMs) || ageMs > policy.maxDataAgeMs) {
      if (!firstSkipDetail) {
        firstSkipReason = "candidate_data_stale";
        firstSkipDetail = `Candidate ${candidate.id} data age ${ageMs}ms > maxDataAgeMs=${policy.maxDataAgeMs}ms`;
      }
      continue;
    }

    const confidence = candidate.confidence ?? 1;
    if (confidence < policy.minConfidence) {
      if (!firstSkipDetail) {
        firstSkipReason = "candidate_low_confidence";
        firstSkipDetail = `Candidate ${candidate.id} confidence ${confidence} < minConfidence=${policy.minConfidence}`;
      }
      continue;
    }

    eligible.push(candidate);
  }

  if (!eligible.length) {
    return {
      action: "hold",
      reason: firstSkipDetail ? firstSkipReason : "no_candidates",
      fromId: context.currentId,
      toId: null,
      scoreDelta: null,
      detail: firstSkipDetail || "No eligible candidates after filtering.",
      evaluatedAt: ts,
    };
  }

  // Deterministic pick: best score, then highest confidence, then lower
  // volatility, then alphabetical id.
  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aConf = a.confidence ?? 1;
    const bConf = b.confidence ?? 1;
    if (bConf !== aConf) return bConf - aConf;
    const aVol = a.volatility ?? 0;
    const bVol = b.volatility ?? 0;
    if (aVol !== bVol) return aVol - bVol;
    return a.id.localeCompare(b.id);
  });

  const best = eligible[0];

  const buildConfidenceInterpretation = (candidate: RotationCandidate): {
    confidenceBreakdown: ConfidenceScore;
    confidenceStrength: "borderline" | "strongly_favored";
    confidenceWhy: string[];
  } => {
    const ageMs = now - Date.parse(candidate.fetchedAt);
    const freshness = computeDecayedFreshnessConfidence(Math.max(0, ageMs)).confidence;

    const defaultOtherFactor = candidate.confidence ?? 1;
    const liquidityQualityEstimate =
      candidate.volatility === undefined
        ? defaultOtherFactor
        : Math.max(0, Math.min(1, 1 - candidate.volatility / 10));

    const factors: ConfidenceFactors = {
      freshness,
      providerAgreement:
        candidate.confidenceFactors?.providerAgreement ?? defaultOtherFactor,
      liquidityQuality:
        candidate.confidenceFactors?.liquidityQuality ?? liquidityQualityEstimate,
      modelCompleteness:
        candidate.confidenceFactors?.modelCompleteness ?? defaultOtherFactor,
    };

    const confidenceBreakdown = computeConfidenceScore(factors);
    const delta = confidenceBreakdown.score - policy.minConfidence;

    const confidenceStrength =
      delta < 0.15 ? "borderline" : "strongly_favored";

    // Prefer “why” strings derived from the caveats; this ensures we
    // explain drivers users can understand without implying guarantees.
    const confidenceWhy = [
      `Confidence label: ${confidenceBreakdown.label}.`,
      ...(confidenceBreakdown.caveats.length > 0
        ? confidenceBreakdown.caveats.map((c) => c)
        : [
            "All confidence factors look strong for this rotation evaluation.",
          ]),
    ];

    return { confidenceBreakdown, confidenceStrength, confidenceWhy };
  };

  if (context.currentId === null || context.currentScore === null) {
    const { confidenceBreakdown, confidenceStrength, confidenceWhy } =
      buildConfidenceInterpretation(best);
    return {
      action: "rotate",
      reason: "no_current_strategy",
      fromId: null,
      toId: best.id,
      scoreDelta: best.score,
      detail: `No incumbent strategy; allocating into ${best.id} (score=${best.score}).`,
      confidenceBreakdown,
      confidenceStrength,
      confidenceWhy,
      evaluatedAt: ts,
    };
  }

  const delta = best.score - context.currentScore;
  if (delta < policy.minScoreDifference) {
    return {
      action: "hold",
      reason: "candidate_below_threshold",
      fromId: context.currentId,
      toId: null,
      scoreDelta: delta,
      detail: `Best candidate ${best.id} delta ${delta.toFixed(3)} < minScoreDifference=${policy.minScoreDifference}.`,
      evaluatedAt: ts,
    };
  }

  const { confidenceBreakdown, confidenceStrength, confidenceWhy } =
    buildConfidenceInterpretation(best);
  return {
    action: "rotate",
    reason: "candidate_better",
    fromId: context.currentId,
    toId: best.id,
    scoreDelta: delta,
    detail: `Rotating ${context.currentId} → ${best.id} (delta=${delta.toFixed(3)}).`,
    confidenceBreakdown,
    confidenceStrength,
    confidenceWhy,
    evaluatedAt: ts,
  };
}

const HISTORY_MAX = 500;

/**
 * Stateful registry. Tracks the current allocation and a bounded history
 * of decisions so consumers can audit rotation behaviour.
 */
export class RotationRegistry {
  private currentId: string | null = null;
  private currentScore: number | null = null;
  private lastRotatedAt: string | null = null;
  private history: RotationDecision[] = [];

  constructor(private policy: RotationPolicy = DEFAULT_ROTATION_POLICY) {}

  current(): {
    id: string | null;
    score: number | null;
    lastRotatedAt: string | null;
  } {
    return {
      id: this.currentId,
      score: this.currentScore,
      lastRotatedAt: this.lastRotatedAt,
    };
  }

  /**
   * Evaluate rotation against the supplied candidates and record the
   * resulting decision. If the action is `rotate`, internal state is
   * advanced to the new strategy.
   */
  evaluate(candidates: RotationCandidate[], now: number = Date.now()): RotationDecision {
    const decision = evaluateRotation(
      {
        currentId: this.currentId,
        currentScore: this.currentScore,
        lastRotatedAt: this.lastRotatedAt,
        candidates,
      },
      this.policy,
      now,
    );

    this.recordDecision(decision);

    if (decision.action === "rotate" && decision.toId) {
      const winner = candidates.find((c) => c.id === decision.toId);
      this.currentId = decision.toId;
      this.currentScore = winner?.score ?? this.currentScore;
      this.lastRotatedAt = decision.evaluatedAt;
    }

    return decision;
  }

  /** Recent decisions, newest first. */
  recentDecisions(limit = 50): RotationDecision[] {
    if (limit <= 0) return [];
    const slice = this.history.slice(-limit);
    return slice.slice().reverse();
  }

  reset(): void {
    this.currentId = null;
    this.currentScore = null;
    this.lastRotatedAt = null;
    this.history = [];
  }

  private recordDecision(decision: RotationDecision): void {
    this.history.push(decision);
    if (this.history.length > HISTORY_MAX) {
      this.history.splice(0, this.history.length - HISTORY_MAX);
    }
  }
}

export const rotationRegistry = new RotationRegistry();
