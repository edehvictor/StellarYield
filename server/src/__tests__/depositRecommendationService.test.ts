import { describe, it, expect } from "vitest";
import {
  generateDepositRecommendations,
  mapRiskProfileToDrawdown,
} from "../services/depositRecommendationService";

describe("depositRecommendationService", () => {
  it.each([
    ["conservative", "conservative"],
    ["balanced", "balanced"],
    ["aggressive", "tolerant"],
  ] as const)("maps %s profile to %s drawdown model", (profile, expected) => {
    expect(mapRiskProfileToDrawdown(profile)).toBe(expected);
  });

  it.each(["conservative", "balanced", "aggressive"] as const)(
    "returns ranked vault recommendations for %s profile",
    (profile) => {
      const result = generateDepositRecommendations({
        riskTolerance: profile,
        timeHorizon: "medium",
        liquidityNeeds: "medium",
      });

      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.recommendations[0].rank).toBe(1);
      expect(result.recommendations[0].explanation.length).toBeGreaterThan(20);
      expect(result.profile).toBe(profile);
    },
  );

  it("conservative profile favors lower-volatility vaults over aggressive", () => {
    const conservative = generateDepositRecommendations({
      riskTolerance: "conservative",
      timeHorizon: "short",
      liquidityNeeds: "high",
    });
    const aggressive = generateDepositRecommendations({
      riskTolerance: "aggressive",
      timeHorizon: "long",
      liquidityNeeds: "low",
    });

    const conservativeTop = conservative.recommendations[0];
    const aggressiveTop = aggressive.recommendations[0];

    expect(conservativeTop.name).toBeDefined();
    expect(aggressiveTop.name).toBeDefined();
    expect(conservative.drawdownProfile).toBe("conservative");
    expect(aggressive.drawdownProfile).toBe("tolerant");
  });

  it("includes explanations for each recommendation", () => {
    const result = generateDepositRecommendations({
      riskTolerance: "balanced",
      timeHorizon: "medium",
      liquidityNeeds: "medium",
    });

    for (const rec of result.recommendations) {
      expect(rec.explanation).toMatch(/Ranked #\d+/);
      expect(rec.matchScore).toBeGreaterThan(0);
    }
  });
});
