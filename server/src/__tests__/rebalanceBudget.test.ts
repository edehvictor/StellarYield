import { RebalanceBudgetService, RebalanceBudgetConfig } from "../services/rebalanceBudgetService";

describe("RebalanceBudgetService", () => {
  const customConfig: RebalanceBudgetConfig = {
    maxTransactionCostUsd: 10.0,
    maxSlippagePct: 1.0,
    minGainNetUsd: 20.0,
    efficiencyThreshold: 3.0,
  };

  it("should approve a highly profitable rebalance", () => {
    const result = RebalanceBudgetService.validateRebalance(100, 2, 3, customConfig);
    expect(result.shouldExecute).toBe(true);
    expect(result.netGain).toBe(95);
  });

  it("should block rebalance if gas cost is too high", () => {
    const result = RebalanceBudgetService.validateRebalance(100, 15, 0, customConfig);
    expect(result.shouldExecute).toBe(false);
    expect(result.reason).toContain("Transaction cost");
  });

  it("should block rebalance if net gain is too low", () => {
    const result = RebalanceBudgetService.validateRebalance(25, 2, 4, customConfig);
    expect(result.shouldExecute).toBe(false);
    expect(result.reason).toContain("Net gain");
  });

  it("should block rebalance if efficiency is too low", () => {
    // cost = 15, gain = 40 -> netGain = 25 (threshold 20, PASSES)
    // efficiency = 40 / 15 = 2.66x (threshold 3x, FAILS)
    const result = RebalanceBudgetService.validateRebalance(40, 5, 10, customConfig);
    expect(result.shouldExecute).toBe(false);
    expect(result.reason).toContain("efficiency");
  });

  it("should handle zero cost gracefully (infinite efficiency)", () => {
    const result = RebalanceBudgetService.validateRebalance(50, 0, 0, customConfig);
    expect(result.shouldExecute).toBe(true);
    expect(result.netGain).toBe(50);
  });

  it("should use default config if none provided", () => {
    // Default: minGainNetUsd = 10.0
    const result = RebalanceBudgetService.validateRebalance(11, 1, 0);
    expect(result.shouldExecute).toBe(true);
  });
});
