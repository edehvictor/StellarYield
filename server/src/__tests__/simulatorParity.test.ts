import {
  simulateDeposit,
  simulateRebalance,
  runRebalanceBacktest,
  type RebalanceParams,
  type RebalanceBacktestParams
} from "../services/simulationService";
import { REBALANCE_FIXTURES } from "../../../shared/test-fixtures/simulatorFixtures";

describe("Simulator Parity Tests", () => {
  it("should ensure blended APY matches between rebalance preview and backtest engine on Day 0", () => {
    for (const fixture of REBALANCE_FIXTURES) {
      const preview = simulateRebalance(fixture.input);

      const backtestParams: RebalanceBacktestParams = {
        initialValueUsd: fixture.input.totalValueUsd,
        startDate: "2025-01-01",
        endDate: "2025-01-02",
        allocations: fixture.input.allocations.map((a) => ({
          label: a.label,
          targetWeight: a.targetWeight,
          apy: a.apy,
        })),
        strategy: "schedule",
        rebalanceIntervalDays: 30,
        feeBps: fixture.input.feeBps ?? 20,
      };

      const backtest = runRebalanceBacktest(backtestParams);

      expect(backtest.snapshots[0].blendedApyPct).toBeCloseTo(preview.blendedApyAfter, 1);
    }
  });

  it("should verify fee calculation formula parity in backtest events", () => {
    const allocations = [
      { label: "Blend-A", currentWeight: 60, targetWeight: 50, apy: 8 },
      { label: "Blend-B", currentWeight: 40, targetWeight: 50, apy: 12 },
    ];
    const totalValue = 100_000;
    const feeBps = 20;

    const backtestParams: RebalanceBacktestParams = {
      initialValueUsd: totalValue,
      startDate: "2025-01-01",
      endDate: "2025-01-02",
      allocations: allocations.map((a) => ({
        label: a.label,
        targetWeight: a.targetWeight,
        apy: a.apy,
      })),
      strategy: "schedule",
      rebalanceIntervalDays: 1,
      feeBps,
    };

    const backtest = runRebalanceBacktest(backtestParams);

    expect(backtest.rebalanceEvents.length).toBeGreaterThan(0);
    const event = backtest.rebalanceEvents[0];
    
    const initialValues = [50000, 50000];
    const factorA = 1 + (8 / 100) / 365;
    const factorB = 1 + (12 / 100) / 365;
    const valA = initialValues[0] * factorA;
    const valB = initialValues[1] * factorB;
    const totalPortfolio = valA + valB;
    
    const targetA = totalPortfolio * 0.5;
    const targetB = totalPortfolio * 0.5;
    
    const grossMovement = Math.abs(valA - targetA) + Math.abs(valB - targetB);
    const turnover = grossMovement / 2;
    const expectedFee = (turnover * feeBps) / 10000;
    
    expect(event.feeUsd).toBeCloseTo(expectedFee, 2);
  });

  it("should output zero turnover, fees, and delta for no-op inputs", () => {
    const noOpInput: RebalanceParams = {
      totalValueUsd: 100_000,
      allocations: [
        { label: "Blend-A", currentWeight: 50, targetWeight: 50, apy: 8 },
        { label: "Blend-B", currentWeight: 50, targetWeight: 50, apy: 8 },
      ],
      feeBps: 20,
    };

    const preview = simulateRebalance(noOpInput);

    expect(preview.blendedApyBefore).toBe(8);
    expect(preview.blendedApyAfter).toBe(8);
    expect(preview.apyDeltaPct).toBe(0);
    expect(preview.totalTurnoverUsd).toBe(0);
    expect(preview.estimatedFeeUsd).toBe(0);
    expect(preview.maxDriftPct).toBe(0);
  });
});
