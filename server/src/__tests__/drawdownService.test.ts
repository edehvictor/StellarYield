import { drawdownService } from "../services/drawdownService";
import { rankStrategies, StrategyInput } from "../services/riskAdjustedYieldService";

describe("DrawdownService", () => {
  it("should estimate drawdown correctly", () => {
    const drawdown = drawdownService.estimateDrawdown(5, 365); // 5% volatility, 1 year history
    expect(drawdown).toBe(7.5); // 5 * 1.5 * 1.0
  });

  it("should increase drawdown estimate for low historical depth", () => {
    const deepHistory = drawdownService.estimateDrawdown(5, 365);
    const shallowHistory = drawdownService.estimateDrawdown(5, 10);
    expect(shallowHistory).toBeGreaterThan(deepHistory);
  });

  it("should calculate yield multiplier based on profile", () => {
    const conservative = drawdownService.calculateYieldMultiplier(10, 'conservative');
    const tolerant = drawdownService.calculateYieldMultiplier(10, 'tolerant');
    expect(tolerant).toBeGreaterThan(conservative);
  });
});

describe("Drawdown-Aware Ranking", () => {
  const mockStrategies: StrategyInput[] = [
    {
      id: "high_risk",
      name: "High Risk",
      strategyType: "blend",
      apy: 20,
      tvlUsd: 1000000,
      ilVolatilityPct: 15,
      riskScore: 5,
    },
    {
      id: "low_risk",
      name: "Low Risk",
      strategyType: "blend",
      apy: 10,
      tvlUsd: 1000000,
      ilVolatilityPct: 2,
      riskScore: 9,
    }
  ];

  it("should rank differently based on profile", () => {
    const conservativeRanked = rankStrategies(mockStrategies, 'conservative');
    const tolerantRanked = rankStrategies(mockStrategies, 'tolerant');

    // In conservative profile, low risk should be higher
    expect(conservativeRanked[0].id).toBe("low_risk");
    
    // In tolerant profile, high risk might be higher (depending on math)
    // Let's check the scores
    const highRiskScoreTolerant = tolerantRanked.find(s => s.id === "high_risk")?.riskAdjustedYield || 0;
    const highRiskScoreConservative = conservativeRanked.find(s => s.id === "high_risk")?.riskAdjustedYield || 0;
    
    expect(highRiskScoreTolerant).toBeGreaterThan(highRiskScoreConservative);
  });
});
