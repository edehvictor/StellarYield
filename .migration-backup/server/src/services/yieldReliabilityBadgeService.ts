/**
 * Dynamic Yield Reliability Badge System (#386)
 *
 * Assigns High / Moderate / Low reliability badges based on data freshness,
 * provider agreement, and trust signals. Low-reliability badges must be
 * visually prominent — never understated.
 */

export type ReliabilityBadge = 'high' | 'moderate' | 'low';

export interface ProtocolTrustSignal {
  protocolId: string;
  protocolName: string;
  ageMonths: number;
  auditsCount: number;
  tvlUsd: number;
  incidentHistory: Array<{ date: string; type: string; resolved: boolean }>;
  operationalStatus: "active" | "degraded" | "maintenance";
}

export const PROTOCOL_TRUST_REGISTRY: Record<string, ProtocolTrustSignal> = {
  blend: {
    protocolId: "blend",
    protocolName: "Blend",
    ageMonths: 18,
    auditsCount: 2,
    tvlUsd: 12_000_000,
    incidentHistory: [],
    operationalStatus: "active",
  },
  aquarius: {
    protocolId: "aquarius",
    protocolName: "Aquarius",
    ageMonths: 36,
    auditsCount: 2,
    tvlUsd: 20_000_000,
    incidentHistory: [{ date: "2024-05-10", type: "exploit-attempt", resolved: true }],
    operationalStatus: "active",
  },
  defindex: {
    protocolId: "defindex",
    protocolName: "DeFindex",
    ageMonths: 6,
    auditsCount: 1,
    tvlUsd: 1_500_000,
    incidentHistory: [],
    operationalStatus: "active",
  },
  soroswap: {
    protocolId: "soroswap",
    protocolName: "Soroswap",
    ageMonths: 12,
    auditsCount: 1,
    tvlUsd: 4_500_000,
    incidentHistory: [{ date: "2024-08-15", type: "oracle-deviation", resolved: true }],
    operationalStatus: "active",
  },
};

export function calculateTrustSignal(protocolId: string): number {
  const signal = PROTOCOL_TRUST_REGISTRY[protocolId.toLowerCase()];
  if (!signal) return 0.5; // default fallback for unknown protocols

  // 1. Age (25% Weight)
  let ageScore = 0.1;
  if (signal.ageMonths >= 24) ageScore = 1.0;
  else if (signal.ageMonths >= 12) ageScore = 0.8;
  else if (signal.ageMonths >= 3) ageScore = 0.5;

  // 2. Audits (25% Weight)
  let auditScore = 0.0;
  if (signal.auditsCount >= 2) auditScore = 1.0;
  else if (signal.auditsCount === 1) auditScore = 0.7;

  // 3. TVL (15% Weight)
  let tvlScore = 0.3;
  if (signal.tvlUsd > 10_000_000) tvlScore = 1.0;
  else if (signal.tvlUsd >= 1_000_000) tvlScore = 0.7;

  // 4. Incidents (20% Weight)
  let incidentScore = 1.0;
  if (signal.incidentHistory.length > 0) {
    const hasUnresolved = signal.incidentHistory.some(inc => !inc.resolved);
    incidentScore = hasUnresolved ? 0.0 : 0.5;
  }

  // 5. Operational Status (15% Weight)
  let opsScore = 1.0;
  if (signal.operationalStatus === "degraded") opsScore = 0.4;
  else if (signal.operationalStatus === "maintenance") opsScore = 0.1;

  const score = ageScore * 0.25 + auditScore * 0.25 + tvlScore * 0.15 + incidentScore * 0.20 + opsScore * 0.15;
  return Math.round(score * 100) / 100;
}

export interface BadgeInput {
  /** 0–1: how recent the data is */
  freshness: number;
  /** 0–1: agreement across providers */
  providerAgreement: number;
  /** 0–1: composite trust signal (uptime, error rate, etc.) */
  trustSignal: number;
  /** Optional protocol ID to dynamically compute trust signal from registry */
  protocolId?: string;
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
    const trust = input.protocolId ? calculateTrustSignal(input.protocolId) : input.trustSignal;
    const score =
      input.freshness * WEIGHTS.freshness +
      input.providerAgreement * WEIGHTS.providerAgreement +
      trust * WEIGHTS.trustSignal;

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

