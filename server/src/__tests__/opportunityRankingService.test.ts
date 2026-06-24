import { OpportunityRankingService, RankingWeights } from "../services/opportunityRankingService";
import { NormalizedYield } from "../types/yields";

describe("OpportunityRankingService", () => {
  const mockNow = Date.parse("2026-06-24T18:00:00Z");

  const createMockYield = (overrides: Partial<NormalizedYield>): NormalizedYield => {
    return {
      protocol: "MockProtocol",
      asset: "USDC",
      risk: "Low",
      protocolName: "MockProtocol",
      apy: 5.0,
      rewardApy: 1.0,
      totalApy: 6.0,
      netApy: 5.5,
      feeDragApy: 0.5,
      tvl: 10_000_000,
      riskScore: 0.2,
      source: "stellar://mock",
      fetchedAt: new Date(mockNow).toISOString(),
      liquidityUsd: 8_000_000,
      rebalancingBehavior: "Static",
      managementFeeBps: 0,
      performanceFeeBps: 1000,
      capitalEfficiencyPct: 80,
      netYieldAssumptions: {
        protocolFeeBps: 0,
        vaultFeeBps: 0,
        rebalanceCostBps: 0,
        slippageBps: 0,
      },
      netYieldSensitivity: [],
      capitalEfficiency: {
        score: 80,
        grade: "B",
        components: {
          utilization: 80,
          feeDrag: 5,
          rotationCost: 5,
          liquidityDepth: 80,
        },
        hasMissingInputs: false,
      },
      attribution: {
        baseYield: 5.0,
        incentives: 1.0,
        compounding: 0.0,
        tacticalRotation: 0.0,
      },
      ...overrides,
    };
  };

  it("calculates ranking scores correctly with default weights", async () => {
    const opportunities = [
      createMockYield({ protocolName: "Blend", totalApy: 6.45, tvl: 12_400_000, liquidityUsd: 11_200_000 }),
      createMockYield({ protocolName: "Soroswap", totalApy: 11.20, tvl: 4_850_000, liquidityUsd: 3_900_000 }),
    ];

    const result = await OpportunityRankingService.rankOpportunities(undefined, opportunities, mockNow);

    expect(result).toHaveLength(2);
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);

    // Blend wins overall because it gets 1.0 on TVL, Liquidity, Volatility (low), and Maturity,
    // which outweighs Soroswap's APY advantage under relative normalization.
    expect(result[0].protocolName).toBe("Blend");
    expect(result[1].protocolName).toBe("Soroswap");
  });

  it("applies custom weights correctly", async () => {
    const opportunities = [
      createMockYield({ protocolName: "Blend", totalApy: 6.45, tvl: 12_400_000, liquidityUsd: 11_200_000 }),
      createMockYield({ protocolName: "Soroswap", totalApy: 11.20, tvl: 4_850_000, liquidityUsd: 3_900_000 }),
    ];

    // If we weight APY at 0, and TVL/liquidity at 1.0, Blend should rank #1
    const weights: Partial<RankingWeights> = {
      apy: 0,
      tvl: 0.5,
      liquidity: 0.5,
      volatility: 0,
      maturity: 0,
    };

    const result = await OpportunityRankingService.rankOpportunities(weights, opportunities, mockNow);
    expect(result[0].protocolName).toBe("Blend");
    expect(result[1].protocolName).toBe("Soroswap");
  });

  it("correctly breaks ties using APY, then TVL, then alphabetically", async () => {
    // To create an exact score tie, we can give identical parameters for all, or set all weights except one to 0
    const opportunities = [
      createMockYield({ protocolName: "A_Protocol", totalApy: 6.0, tvl: 10_000_000, liquidityUsd: 8_000_000 }),
      createMockYield({ protocolName: "B_Protocol", totalApy: 6.0, tvl: 10_000_000, liquidityUsd: 8_000_000 }),
      createMockYield({ protocolName: "C_Protocol", totalApy: 7.0, tvl: 10_000_000, liquidityUsd: 8_000_000 }),
      createMockYield({ protocolName: "D_Protocol", totalApy: 6.0, tvl: 12_000_000, liquidityUsd: 8_000_000 }),
    ];

    // All these have same volatility and age because they fall back to default or same protocolName lookup
    // Set all weights to 1 (they get normalized) so scores could be different, but let's test tie breaking
    // We want to verify that C ranks first (higher APY), then D (higher TVL), then A, then B (alphabetical)
    const result = await OpportunityRankingService.rankOpportunities(
      { apy: 0.2, tvl: 0.2, liquidity: 0.2, volatility: 0.2, maturity: 0.2 },
      opportunities,
      mockNow
    );

    // C has higher APY, so it should have higher score and rank 1
    // D has higher TVL, so it should have higher score and rank 2 (or tie-break)
    // A and B have exact same metrics. They tie in score. A should break tie over B alphabetically.
    expect(result[0].protocolName).toBe("C_Protocol");
    expect(result[1].protocolName).toBe("D_Protocol");
    expect(result[2].protocolName).toBe("A_Protocol");
    expect(result[3].protocolName).toBe("B_Protocol");
  });

  it("rejects malformed or negative data", async () => {
    const opportunities = [
      createMockYield({ protocolName: "Valid", totalApy: 6.0, tvl: 10_000_000 }),
      createMockYield({ protocolName: "NegativeAPY", totalApy: -1.0, tvl: 10_000_000 }),
      createMockYield({ protocolName: "NegativeTVL", totalApy: 6.0, tvl: -100 }),
      createMockYield({ protocolName: "MissingAPY", totalApy: undefined as any }),
    ];

    const result = await OpportunityRankingService.rankOpportunities(undefined, opportunities, mockNow);
    expect(result).toHaveLength(1);
    expect(result[0].protocolName).toBe("Valid");
  });

  it("rejects stale data (older than 24 hours)", async () => {
    const twentyFiveHoursAgo = new Date(mockNow - 25 * 60 * 60 * 1000).toISOString();
    const opportunities = [
      createMockYield({ protocolName: "Fresh", fetchedAt: new Date(mockNow).toISOString() }),
      createMockYield({ protocolName: "Stale", fetchedAt: twentyFiveHoursAgo }),
    ];

    const result = await OpportunityRankingService.rankOpportunities(undefined, opportunities, mockNow);
    expect(result).toHaveLength(1);
    expect(result[0].protocolName).toBe("Fresh");
  });
});
