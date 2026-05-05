/**
 * Cohort Comparison Service (#385)
 *
 * Compares strategy recommendation behaviour across user cohorts.
 * All outputs are aggregated — no individual user data is exposed.
 */

export type RiskProfile = 'conservative' | 'moderate' | 'aggressive';
export type DepositSize = 'small' | 'medium' | 'large';
export type Horizon = 'short' | 'medium' | 'long';

export interface CohortDefinition {
  riskProfile?: RiskProfile;
  depositSize?: DepositSize;
  horizon?: Horizon;
}

export interface CohortRecommendationSummary {
  cohort: CohortDefinition;
  /** Number of users in cohort (never < MIN_COHORT_SIZE to prevent re-identification) */
  userCount: number;
  topStrategies: Array<{ strategyId: string; allocationPct: number }>;
  avgExpectedApy: number;
  avgRiskScore: number;
}

export interface CohortComparisonResult {
  cohorts: CohortRecommendationSummary[];
  generatedAt: string;
}

/** Minimum cohort size to prevent individual re-identification */
const MIN_COHORT_SIZE = 5;

export interface UserProfile {
  userId: string;
  riskProfile: RiskProfile;
  depositSize: DepositSize;
  horizon: Horizon;
  recommendedStrategies: Array<{ strategyId: string; allocationPct: number }>;
  expectedApy: number;
  riskScore: number;
}

function matchesCohort(user: UserProfile, cohort: CohortDefinition): boolean {
  if (cohort.riskProfile && user.riskProfile !== cohort.riskProfile) return false;
  if (cohort.depositSize && user.depositSize !== cohort.depositSize) return false;
  if (cohort.horizon && user.horizon !== cohort.horizon) return false;
  return true;
}

function aggregateStrategies(
  users: UserProfile[]
): Array<{ strategyId: string; allocationPct: number }> {
  const totals: Record<string, number> = {};
  for (const u of users) {
    for (const s of u.recommendedStrategies) {
      totals[s.strategyId] = (totals[s.strategyId] ?? 0) + s.allocationPct;
    }
  }
  return Object.entries(totals)
    .map(([strategyId, total]) => ({
      strategyId,
      allocationPct: Math.round(total / users.length),
    }))
    .sort((a, b) => b.allocationPct - a.allocationPct)
    .slice(0, 5);
}

export class CohortComparisonService {
  /**
   * Compare recommendation behaviour across the given cohort definitions.
   * Users that don't meet MIN_COHORT_SIZE are excluded to preserve privacy.
   */
  compare(
    users: UserProfile[],
    cohorts: CohortDefinition[]
  ): CohortComparisonResult {
    const summaries: CohortRecommendationSummary[] = [];

    for (const cohort of cohorts) {
      const members = users.filter((u) => matchesCohort(u, cohort));
      if (members.length < MIN_COHORT_SIZE) continue; // privacy guard

      const avgApy =
        members.reduce((s, u) => s + u.expectedApy, 0) / members.length;
      const avgRisk =
        members.reduce((s, u) => s + u.riskScore, 0) / members.length;

      summaries.push({
        cohort,
        userCount: members.length,
        topStrategies: aggregateStrategies(members),
        avgExpectedApy: Math.round(avgApy * 100) / 100,
        avgRiskScore: Math.round(avgRisk * 100) / 100,
      });
    }

    return { cohorts: summaries, generatedAt: new Date().toISOString() };
  }
}

export const cohortComparisonService = new CohortComparisonService();
