/**
 * Dynamic Yield Reliability Badge System (#386)
 *
 * Assigns High / Moderate / Low reliability badges based on data freshness,
 * provider agreement, and trust signals. Low-reliability badges must be
 * visually prominent — never understated.
 */

export type ReliabilityBadge = 'high' | 'moderate' | 'low';

export interface BadgeInput {
  /** 0–1: how recent the data is */
  freshness: number;
  /** 0–1: agreement across providers */
  providerAgreement: number;
  /** 0–1: composite trust signal (uptime, error rate, etc.) */
  trustSignal: number;
}

export interface BadgeResult {
  badge: ReliabilityBadge;
  score: number;
  /** Human-readable reason for the assigned badge */
  reason: string;
}

/** Thresholds for badge assignment (inclusive lower bound) */
const THRESHOLDS = { high: 0.75, moderate: 0.45 } as const;

/** Weights for the composite score */
const WEIGHTS = { freshness: 0.4, providerAgreement: 0.35, trustSignal: 0.25 } as const;

export class YieldReliabilityBadgeService {
  assignBadge(input: BadgeInput): BadgeResult {
    const score =
      input.freshness * WEIGHTS.freshness +
      input.providerAgreement * WEIGHTS.providerAgreement +
      input.trustSignal * WEIGHTS.trustSignal;

    const rounded = Math.round(score * 1000) / 1000;

    if (rounded >= THRESHOLDS.high) {
      return { badge: 'high', score: rounded, reason: 'Fresh data with strong provider agreement and high trust.' };
    }
    if (rounded >= THRESHOLDS.moderate) {
      return { badge: 'moderate', score: rounded, reason: 'Acceptable data quality; some signals are weaker than ideal.' };
    }
    return {
      badge: 'low',
      score: rounded,
      reason: 'Data is stale, providers disagree, or trust signals are weak. Treat displayed yield with caution.',
    };
  }

  /** Batch-assign badges for multiple sources */
  assignBadges(inputs: Record<string, BadgeInput>): Record<string, BadgeResult> {
    return Object.fromEntries(
      Object.entries(inputs).map(([id, input]) => [id, this.assignBadge(input)])
    );
  }
}

export const yieldReliabilityBadgeService = new YieldReliabilityBadgeService();
