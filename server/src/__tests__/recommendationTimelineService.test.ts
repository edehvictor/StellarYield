import {
  getRecommendationTimeline,
  recordRecommendation,
  resetRecommendationTimelineStore,
  REASON_CODE_LABELS,
} from "../services/recommendationTimelineService";
import {
  FIXED_BASE_TIME,
  RECOMMENDATION_FIXTURE_CASES,
} from "../tests/fixtures/recommendationTimelineFixtures";

describe("recommendationTimelineService", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FIXED_BASE_TIME));
    jest.spyOn(Date, "now").mockReturnValue(1_725_000_000_000);
    jest.spyOn(Math, "random").mockReturnValue(0.456789);
    resetRecommendationTimelineStore();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("stores recommendation history with timestamps", async () => {
    const entry = await recordRecommendation("user-1", {
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

    expect(entry.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.id).toBe("1725000000000-74f01f");
    const timeline = await getRecommendationTimeline("user-1");
    expect(timeline).toHaveLength(1);
    expect(timeline[0].changedInputs).toContain("initial-baseline");
  });

  it("tracks changed inputs against prior recommendation", async () => {
    await recordRecommendation("user-2", {
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

    const updated = await recordRecommendation("user-2", {
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

  describe("reasonCodes", () => {
    it("generates initial-baseline reason code for first entry", async () => {
      const entry = await recordRecommendation("user-3", {
        recommendation: "Start with Blend.",
        targetVault: "Blend",
        rationale: "Getting started.",
        inputSnapshot: {
          riskTolerance: "medium",
          expectedApy: 6,
          liquidityDepthUsd: 1_000_000,
          volatilityPct: 5,
        },
      });

      expect(entry.reasonCodes).toHaveLength(1);
      expect(entry.reasonCodes[0].code).toBe("initial-baseline");
    });

    it("generates apy-shift reason code when APY changes ≥ 0.5", async () => {
      await recordRecommendation("user-4", {
        recommendation: "First.",
        targetVault: "Vault A",
        rationale: "Initial.",
        inputSnapshot: {
          riskTolerance: "medium",
          expectedApy: 6,
          liquidityDepthUsd: 1_000_000,
          volatilityPct: 5,
        },
      });

      const second = await recordRecommendation("user-4", {
        recommendation: "Second.",
        targetVault: "Vault B",
        rationale: "Changed.",
        inputSnapshot: {
          riskTolerance: "medium",
          expectedApy: 7.5,
          liquidityDepthUsd: 1_000_000,
          volatilityPct: 5,
        },
      });

      expect(second.reasonCodes.some((rc) => rc.code === "apy-shift")).toBe(true);
      expect(second.reasonCodes.some((rc) => rc.code === "initial-baseline")).toBe(false);
    });

    it("generates volatility-change reason code when volatility changes ≥ 1", async () => {
      await recordRecommendation("user-5", {
        recommendation: "First.",
        targetVault: "Vault A",
        rationale: "Initial.",
        inputSnapshot: {
          riskTolerance: "medium",
          expectedApy: 6,
          liquidityDepthUsd: 1_000_000,
          volatilityPct: 3,
        },
      });

      const second = await recordRecommendation("user-5", {
        recommendation: "Second.",
        targetVault: "Vault B",
        rationale: "Changed.",
        inputSnapshot: {
          riskTolerance: "medium",
          expectedApy: 6,
          liquidityDepthUsd: 1_000_000,
          volatilityPct: 7,
        },
      });

      expect(second.reasonCodes.some((rc) => rc.code === "volatility-change")).toBe(true);
      const volRc = second.reasonCodes.find((rc) => rc.code === "volatility-change");
      expect(volRc?.previousValue).toBe(3);
      expect(volRc?.currentValue).toBe(7);
    });

    it("generates risk-tolerance-change reason code", async () => {
      await recordRecommendation("user-6", {
        recommendation: "First.",
        targetVault: "Vault A",
        rationale: "Initial.",
        inputSnapshot: {
          riskTolerance: "low",
          expectedApy: 6,
          liquidityDepthUsd: 1_000_000,
          volatilityPct: 5,
        },
      });

      const second = await recordRecommendation("user-6", {
        recommendation: "Second.",
        targetVault: "Vault B",
        rationale: "Changed.",
        inputSnapshot: {
          riskTolerance: "high",
          expectedApy: 6,
          liquidityDepthUsd: 1_000_000,
          volatilityPct: 5,
        },
      });

      expect(second.reasonCodes.some((rc) => rc.code === "risk-tolerance-change")).toBe(true);
      const rtRc = second.reasonCodes.find((rc) => rc.code === "risk-tolerance-change");
      expect(rtRc?.previousValue).toBe("low");
      expect(rtRc?.currentValue).toBe("high");
    });

    it("generates liquidity-change reason code when liquidity changes ≥ 50k", async () => {
      await recordRecommendation("user-7", {
        recommendation: "First.",
        targetVault: "Vault A",
        rationale: "Initial.",
        inputSnapshot: {
          riskTolerance: "medium",
          expectedApy: 6,
          liquidityDepthUsd: 500_000,
          volatilityPct: 5,
        },
      });

      const second = await recordRecommendation("user-7", {
        recommendation: "Second.",
        targetVault: "Vault B",
        rationale: "Changed.",
        inputSnapshot: {
          riskTolerance: "medium",
          expectedApy: 6,
          liquidityDepthUsd: 1_000_000,
          volatilityPct: 5,
        },
      });

      expect(second.reasonCodes.some((rc) => rc.code === "liquidity-change")).toBe(true);
    });

    it("includes severity levels in reason codes", async () => {
      const entry = await recordRecommendation("user-8", {
        recommendation: "Test.",
        targetVault: "Vault",
        rationale: "Testing severity.",
        inputSnapshot: {
          riskTolerance: "medium",
          expectedApy: 6,
          liquidityDepthUsd: 1_000_000,
          volatilityPct: 5,
        },
      });

      const rc = entry.reasonCodes[0];
      expect(["info", "warning", "critical"]).toContain(rc.severity);
    });

    it("includes reason code labels from REASON_CODE_LABELS", async () => {
      const entry = await recordRecommendation("user-9", {
        recommendation: "Test.",
        targetVault: "Vault",
        rationale: "Testing labels.",
        inputSnapshot: {
          riskTolerance: "medium",
          expectedApy: 6,
          liquidityDepthUsd: 1_000_000,
          volatilityPct: 5,
        },
      });

      const rc = entry.reasonCodes[0];
      expect(rc.label).toBe(REASON_CODE_LABELS[rc.code].label);
      expect(rc.description).toBe(REASON_CODE_LABELS[rc.code].description);
    });
  });

  it("returns empty array for unknown user", () => {
    expect(getRecommendationTimeline("unknown-user")).toEqual([]);
  });

  it("caps entries at MAX_ENTRIES_PER_USER", async () => {
    const many = Array.from({ length: 25 }, (_, i) => i);
    for (const i of many) {
      await recordRecommendation("user-capped", {
        recommendation: `Entry ${i}`,
        targetVault: "Vault",
        rationale: "Bulk add.",
        inputSnapshot: {
          riskTolerance: "medium",
          expectedApy: 5 + i / 100,
          liquidityDepthUsd: 1_000_000,
          volatilityPct: 5,
        },
      });
    }
    const timeline = getRecommendationTimeline("user-capped");
    expect(timeline.length).toBeLessThanOrEqual(20);
  });

  it("keeps most recent target vault first", async () => {
    await recordRecommendation("user-order", {
      recommendation: "Base recommendation",
      targetVault: "Blend Stable",
      rationale: "Start conservatively.",
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 5.2,
        liquidityDepthUsd: 1_400_000,
        volatilityPct: 2.2,
      },
    });
    await recordRecommendation("user-order", {
      recommendation: "Volatility hedge recommendation",
      targetVault: "DeFindex Shield",
      rationale: "Market has become unstable.",
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 4.5,
        liquidityDepthUsd: 1_360_000,
        volatilityPct: 3.5,
      },
    });

    const timeline = getRecommendationTimeline("user-order");
    expect(timeline[0]?.targetVault).toBe("DeFindex Shield");
    expect(timeline[1]?.targetVault).toBe("Blend Stable");
  });

  describe("deterministic fixture matrix", () => {
    it.each(RECOMMENDATION_FIXTURE_CASES)(
      "asserts reason codes and target vault changes for $profile profile",
      async ({ initial, transitions }) => {
        const userId = `fixture-${initial.profile}`;
        await recordRecommendation(userId, {
          recommendation: initial.recommendation,
          targetVault: initial.targetVault,
          rationale: initial.rationale,
          inputSnapshot: initial.inputSnapshot,
        });

        for (const step of transitions) {
          const entry = await recordRecommendation(userId, {
            recommendation: step.next.recommendation,
            targetVault: step.next.targetVault,
            rationale: step.next.rationale,
            inputSnapshot: step.next.inputSnapshot,
          });

          const codes = entry.reasonCodes.map((rc) => rc.code);
          expect(codes).toEqual(expect.arrayContaining(step.expectedReasonCodes));
          expect(entry.targetVault).toBe(step.next.targetVault);
        }

        const timeline = getRecommendationTimeline(userId);
        expect(timeline[0]?.targetVault).toBe(transitions[transitions.length - 1].next.targetVault);
        expect(timeline[timeline.length - 1]?.targetVault).toBe(initial.targetVault);
      },
    );
  });
});
