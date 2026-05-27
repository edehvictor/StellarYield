import { rankStrategies } from "../../services/riskAdjustedYieldService";
import { DrawdownToleranceProfile } from "../../services/drawdownService";

// Test the core ranking logic used by the wizard for all three profiles
describe("Risk-Adjusted Wizard – rankStrategies profiles", () => {
  const strategies = [
    {
      id: "safe",
      name: "Safe Vault",
      strategyType: "blend",
      apy: 6,
      tvlUsd: 3_000_000,
      ilVolatilityPct: 2,
      riskScore: 9,
      historicalDepthDays: 365,
    },
    {
      id: "mid",
      name: "Mid Vault",
      strategyType: "soroswap",
      apy: 15,
      tvlUsd: 800_000,
      ilVolatilityPct: 18,
      riskScore: 6,
      historicalDepthDays: 180,
    },
    {
      id: "risky",
      name: "Risky Vault",
      strategyType: "soroswap",
      apy: 40,
      tvlUsd: 200_000,
      ilVolatilityPct: 50,
      riskScore: 3,
      historicalDepthDays: 90,
    },
  ];

  it("conservative profile ranks the safest vault first", () => {
    const ranked = rankStrategies(strategies, "conservative" as DrawdownToleranceProfile);
    expect(ranked[0].id).toBe("safe");
    expect(ranked[0].rank).toBe(1);
  });

  it("balanced profile produces a middle-ground ranking", () => {
    const ranked = rankStrategies(strategies, "balanced" as DrawdownToleranceProfile);
    // safe or mid should lead; risky should not be #1
    expect(ranked[0].id).not.toBe("risky");
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("aggressive (tolerant) profile allows high-yield vaults to rank higher", () => {
    const ranked = rankStrategies(strategies, "tolerant" as DrawdownToleranceProfile);
    // risky vault should rank higher than in conservative
    const riskyRankAggressive = ranked.find((r) => r.id === "risky")!.rank;
    const conservativeRanked = rankStrategies(strategies, "conservative");
    const riskyRankConservative = conservativeRanked.find((r) => r.id === "risky")!.rank;
    expect(riskyRankAggressive).toBeLessThanOrEqual(riskyRankConservative);
  });

  it("all ranked strategies have riskAdjustedYield >= 0", () => {
    for (const profile of ["conservative", "balanced", "tolerant"] as DrawdownToleranceProfile[]) {
      const ranked = rankStrategies(strategies, profile);
      ranked.forEach((r) => {
        expect(r.riskAdjustedYield).toBeGreaterThanOrEqual(0);
      });
    }
  });

  it("returns strategies in ascending rank order (1, 2, 3)", () => {
    const ranked = rankStrategies(strategies, "balanced");
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });
});
