import {
  getRecommendationTimeline,
  recordRecommendation,
  resetRecommendationTimelineStore,
} from "../services/recommendationTimelineService";

describe("recommendationTimelineService", () => {
  beforeEach(() => {
    resetRecommendationTimelineStore();
  });

  it("stores recommendation history with timestamps", () => {
    const entry = recordRecommendation("user-1", {
      recommendation: "Allocate to Blend vault.",
      targetVault: "Blend Stable",
      rationale: "Stable fees and deep liquidity.",
      inputSnapshot: {
        riskTolerance: "medium",
        expectedApy: 8.2,
        liquidityDepthUsd: 1_500_000,
        volatilityPct: 4,
      },
    });

    expect(entry.timestamp).toBeTruthy();
    const timeline = getRecommendationTimeline("user-1");
    expect(timeline).toHaveLength(1);
    expect(timeline[0].changedInputs).toContain("initial-baseline");
  });

  it("tracks changed inputs against prior recommendation", () => {
    recordRecommendation("user-2", {
      recommendation: "Use DeFindex index vault.",
      targetVault: "DeFindex Index",
      rationale: "Diversified routing.",
      inputSnapshot: {
        riskTolerance: "low",
        expectedApy: 7,
        liquidityDepthUsd: 2_000_000,
        volatilityPct: 3,
      },
    });

    const updated = recordRecommendation("user-2", {
      recommendation: "Switch to Soroswap LP.",
      targetVault: "Soroswap LP",
      rationale: "Yield increased after volatility shift.",
      inputSnapshot: {
        riskTolerance: "high",
        expectedApy: 9.4,
        liquidityDepthUsd: 1_800_000,
        volatilityPct: 6,
      },
    });

    expect(updated.changedInputs).toEqual(
      expect.arrayContaining(["riskTolerance", "expectedApy", "volatilityPct"]),
    );
  });
});
