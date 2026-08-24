import { describe, it, expect } from 'vitest';
import {
  SIMULATOR_FIXTURES,
  SIMULATOR_EDGE_CASES,
  REBALANCE_FIXTURES,
  REBALANCE_EDGE_CASES,
  FAILOVER_FIXTURES,
  validateSimulationResult,
  validateRebalanceResult,
  validateFailoverResult,
  type SimulatorFixture,
  type RebalanceFixture,
  type FailoverFixture,
} from '../../../../../shared/test-fixtures/simulatorFixtures';

describe('Shared Simulator Fixtures – Client', () => {
  describe('Deposit fixture contracts', () => {
    it('should export at least 4 deposit fixtures', () => {
      expect(SIMULATOR_FIXTURES.length).toBeGreaterThanOrEqual(4);
    });

    for (const fixture of SIMULATOR_FIXTURES) {
      it(`fixture "${fixture.description}" has valid shape`, () => {
        expect(fixture.input.strategyId).toBeTruthy();
        expect(typeof fixture.input.amount).toBe('number');
        expect(fixture.input.token).toBeTruthy();
        expect(typeof fixture.expectedOutput.hasEntryFee).toBe('boolean');
        expect(typeof fixture.expectedOutput.hasNetworkFee).toBe('boolean');
        expect(fixture.expectedOutput.expectedApyRange.min).toBeLessThanOrEqual(
          fixture.expectedOutput.expectedApyRange.max,
        );
      });
    }

    for (const fixture of SIMULATOR_EDGE_CASES) {
      it(`edge case "${fixture.description}" expects a warning`, () => {
        const w = fixture.expectedOutput.expectedWarnings;
        const hasExpectedWarning = w.highSlippage || w.insufficientLiquidity || w.unsupported;
        expect(hasExpectedWarning).toBe(true);
      });
    }
  });

  describe('validateSimulationResult helper', () => {
    it('returns valid for a conforming result', () => {
      const fixture = SIMULATOR_FIXTURES[0];
      const mockResult = {
        fees: [
          { type: 'Entry Fee', amount: 1 },
          { type: 'Network Fee Estimate', amount: 0.05 },
        ],
        allocations: [{ protocol: 'blend', amount: fixture.expectedOutput.allocationsSum, percentage: 99.9 }],
        postDepositExposure: { expectedApy: 5 },
        warnings: [],
        routing: { path: ['blend'] },
      };
      const { valid, errors } = validateSimulationResult(fixture, mockResult);
      expect(valid).toBe(true);
      expect(errors).toEqual([]);
    });

    it('returns errors for a non-conforming result', () => {
      const fixture = SIMULATOR_FIXTURES[0];
      const badResult = {
        fees: [],
        allocations: [],
        postDepositExposure: { expectedApy: -1 },
        warnings: [],
        routing: { path: [] },
      };
      const { valid, errors } = validateSimulationResult(fixture, badResult);
      expect(valid).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('Rebalance fixture contracts', () => {
    it('should export at least 3 rebalance fixtures', () => {
      expect(REBALANCE_FIXTURES.length).toBeGreaterThanOrEqual(3);
    });

    for (const fixture of REBALANCE_FIXTURES) {
      it(`fixture "${fixture.description}" has valid shape`, () => {
        expect(fixture.input.totalValueUsd).toBeGreaterThan(0);
        expect(fixture.input.allocations.length).toBeGreaterThan(0);
        const currentSum = fixture.input.allocations.reduce((s, a) => s + a.currentWeight, 0);
        const targetSum = fixture.input.allocations.reduce((s, a) => s + a.targetWeight, 0);
        expect(currentSum).toBeCloseTo(100, 0);
        expect(targetSum).toBeCloseTo(100, 0);
      });
    }

    for (const fixture of REBALANCE_EDGE_CASES) {
      it(`edge case "${fixture.description}" has valid shape`, () => {
        expect(fixture.input.totalValueUsd).toBeGreaterThan(0);
      });
    }
  });

  describe('validateRebalanceResult helper', () => {
    it('returns valid for a conforming result', () => {
      const fixture = REBALANCE_FIXTURES[0];
      const mockResult = {
        legs: fixture.input.allocations.map((a) => ({
          label: a.label,
          currentWeight: a.currentWeight,
          targetWeight: a.targetWeight,
          driftPct: a.targetWeight - a.currentWeight,
        })),
        blendedApyBefore: 9.6,
        blendedApyAfter: 10,
        apyDeltaPct: 0.4,
        totalTurnoverUsd: 10_000,
        estimatedFeeUsd: 20,
        maxDriftPct: 10,
        warnings: [],
      };
      const { valid, errors } = validateRebalanceResult(fixture, mockResult);
      expect(valid).toBe(true);
      expect(errors).toEqual([]);
    });
  });

  describe('Failover (backtest) fixture contracts', () => {
    it('should export at least 2 failover fixtures', () => {
      expect(FAILOVER_FIXTURES.length).toBeGreaterThanOrEqual(2);
    });

    for (const fixture of FAILOVER_FIXTURES) {
      it(`fixture "${fixture.description}" has valid dates`, () => {
        const start = new Date(fixture.input.startDate);
        const end = new Date(fixture.input.endDate);
        expect(start.getTime()).toBeLessThan(end.getTime());
        expect(fixture.input.initialValueUsd).toBeGreaterThan(0);
      });
    }
  });

  describe('validateFailoverResult helper', () => {
    it('returns valid for a conforming result', () => {
      const fixture = FAILOVER_FIXTURES[0];
      const mockResult = {
        finalPortfolioValue: 102_000,
        finalPassiveValue: 101_500,
        rebalanceCount: 2,
        totalFeesUsd: 5,
      };
      const { valid, errors } = validateFailoverResult(fixture, mockResult);
      expect(valid).toBe(true);
      expect(errors).toEqual([]);
    });
  });

  describe('Fixture determinism', () => {
    it('all deposit fixtures have unique descriptions', () => {
      const descriptions = [...SIMULATOR_FIXTURES, ...SIMULATOR_EDGE_CASES].map((f) => f.description);
      expect(new Set(descriptions).size).toBe(descriptions.length);
    });

    it('all rebalance fixtures have unique descriptions', () => {
      const descriptions = [...REBALANCE_FIXTURES, ...REBALANCE_EDGE_CASES].map((f) => f.description);
      expect(new Set(descriptions).size).toBe(descriptions.length);
    });

    it('all failover fixtures have unique descriptions', () => {
      const descriptions = FAILOVER_FIXTURES.map((f) => f.description);
      expect(new Set(descriptions).size).toBe(descriptions.length);
    });
  });
});
