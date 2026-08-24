import {
  SIMULATOR_FIXTURES,
  SIMULATOR_EDGE_CASES,
  REBALANCE_FIXTURES,
  REBALANCE_EDGE_CASES,
  FAILOVER_FIXTURES,
  validateSimulationResult,
  validateRebalanceResult,
  validateFailoverResult,
} from '../../../shared/test-fixtures/simulatorFixtures';
import { simulateDeposit, simulateRebalance, runRebalanceBacktest } from '../services/simulationService';

describe('Shared Simulator Fixtures – Server', () => {
  describe('Deposit fixtures', () => {
    for (const fixture of SIMULATOR_FIXTURES) {
      it(fixture.description, () => {
        const result = simulateDeposit(fixture.input);
        const { valid, errors } = validateSimulationResult(fixture, result);
        expect(errors).toEqual([]);
        expect(valid).toBe(true);
      });
    }
  });

  describe('Deposit edge cases', () => {
    for (const fixture of SIMULATOR_EDGE_CASES) {
      it(fixture.description, () => {
        const result = simulateDeposit(fixture.input);
        if (fixture.input.amount <= 0) {
          expect(result.warnings.length).toBeGreaterThan(0);
        } else {
          expect(result.isSimulationOnly).toBe(true);
        }
      });
    }
  });

  describe('Rebalance fixtures', () => {
    for (const fixture of REBALANCE_FIXTURES) {
      it(fixture.description, () => {
        const result = simulateRebalance(fixture.input);
        const { valid, errors } = validateRebalanceResult(fixture, result);
        expect(errors).toEqual([]);
        expect(valid).toBe(true);
      });
    }
  });

  describe('Rebalance edge cases', () => {
    for (const fixture of REBALANCE_EDGE_CASES) {
      it(fixture.description, () => {
        const result = simulateRebalance(fixture.input);
        const { valid, errors } = validateRebalanceResult(fixture, result);
        expect(errors).toEqual([]);
        expect(valid).toBe(true);
      });
    }
  });

  describe('Failover (backtest) fixtures', () => {
    for (const fixture of FAILOVER_FIXTURES) {
      it(fixture.description, () => {
        const result = runRebalanceBacktest(fixture.input);
        const { valid, errors } = validateFailoverResult(fixture, result);
        expect(errors).toEqual([]);
        expect(valid).toBe(true);
      });
    }
  });
});
