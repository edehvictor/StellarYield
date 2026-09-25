import { CohortComparisonService, UserProfile } from '../cohortComparisonService';

const svc = new CohortComparisonService();

const makeUser = (
  id: string,
  overrides: Partial<UserProfile> = {}
): UserProfile => ({
  userId: id,
  riskProfile: 'moderate',
  depositSize: 'medium',
  horizon: 'medium',
  recommendedStrategies: [{ strategyId: 'strat-A', allocationPct: 60 }, { strategyId: 'strat-B', allocationPct: 40 }],
  expectedApy: 8,
  riskScore: 0.5,
  ...overrides,
});

const users: UserProfile[] = [
  ...Array.from({ length: 6 }, (_, i) => makeUser(`u${i}`, { riskProfile: 'conservative', expectedApy: 5, riskScore: 0.2 })),
  ...Array.from({ length: 6 }, (_, i) => makeUser(`a${i}`, { riskProfile: 'aggressive', expectedApy: 15, riskScore: 0.8 })),
];

describe('CohortComparisonService', () => {
  it('returns aggregated summaries per cohort', () => {
    const result = svc.compare(users, [
      { riskProfile: 'conservative' },
      { riskProfile: 'aggressive' },
    ]);
    expect(result.cohorts).toHaveLength(2);
    expect(result.cohorts[0].avgExpectedApy).toBe(5);
    expect(result.cohorts[1].avgExpectedApy).toBe(15);
  });

  it('excludes cohorts below MIN_COHORT_SIZE (privacy guard)', () => {
    const small = [makeUser('x1'), makeUser('x2')]; // only 2 users
    const result = svc.compare(small, [{ riskProfile: 'moderate' }]);
    expect(result.cohorts).toHaveLength(0);
  });

  it('does not expose individual user data', () => {
    const result = svc.compare(users, [{ riskProfile: 'conservative' }]);
    const summary = result.cohorts[0];
    expect(summary).not.toHaveProperty('userId');
    expect(summary.userCount).toBeGreaterThanOrEqual(5);
  });

  it('aggregates top strategies correctly', () => {
    const result = svc.compare(users, [{ riskProfile: 'conservative' }]);
    const top = result.cohorts[0].topStrategies[0];
    expect(top.strategyId).toBe('strat-A');
    expect(top.allocationPct).toBe(60);
  });
});
