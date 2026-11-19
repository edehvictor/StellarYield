/**
 * Test fixtures for recommendation pagination contract tests
 *
 * Provides realistic data scenarios:
 * - Repeated timestamps (edge case for cursor stability)
 * - Mixed recommendation types with different reason codes
 * - Various risk profiles and market conditions
 */

import type {
  RecommendationTimelineEntry,
  RecommendationInputSnapshot,
  ReasonCodeDetail,
} from "../../services/recommendationTimelineService";

export interface RecommendationFixture {
  name: string;
  description: string;
  userId: string;
  entries: Array<
    Omit<RecommendationTimelineEntry, "id" | "timestamp" | "reasonCodes"> & {
      timestamp?: string; // If not provided, will be auto-generated
      delayMs?: number; // Delay before creating this entry
    }
  >;
}

/**
 * Fixture: Multiple recommendations with same timestamp
 * Tests that pagination cursor handles timestamp collisions correctly
 */
export const REPEATED_TIMESTAMPS_FIXTURE: RecommendationFixture = {
  name: "repeated-timestamps",
  description: "Multiple recommendation entries with identical timestamps",
  userId: "user-repeated-timestamps",
  entries: [
    {
      timestamp: "2026-01-15T10:00:00.000Z",
      recommendation: "Start with portfolio A",
      rationale: "Initial assessment",
      targetVault: "vault-agg-stable-1",
      changedInputs: ["initial"],
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 5.2,
        liquidityDepthUsd: 250000,
        volatilityPct: 1.8,
      },
    },
    {
      timestamp: "2026-01-15T10:00:00.000Z",
      recommendation: "Alternative: portfolio B",
      rationale: "Backup strategy same day",
      targetVault: "vault-agg-balanced-1",
      changedInputs: [],
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 6.1,
        liquidityDepthUsd: 250000,
        volatilityPct: 2.1,
      },
    },
    {
      timestamp: "2026-01-15T10:00:00.000Z",
      recommendation: "Conservative alternative C",
      rationale: "Third option same timestamp",
      targetVault: "vault-core-usdc",
      changedInputs: [],
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 4.8,
        liquidityDepthUsd: 250000,
        volatilityPct: 0.5,
      },
    },
    {
      timestamp: "2026-01-14T15:30:00.000Z",
      recommendation: "Previous day recommendation",
      rationale: "Earlier recommendation",
      targetVault: "vault-agg-stable-1",
      changedInputs: [],
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 5.0,
        liquidityDepthUsd: 250000,
        volatilityPct: 1.5,
      },
    },
  ],
};

/**
 * Fixture: Mixed recommendation types with different reason codes
 * Tests pagination preserves reason code tracking across pages
 */
export const MIXED_TYPES_FIXTURE: RecommendationFixture = {
  name: "mixed-types",
  description: "Recommendations with different reason codes and scenarios",
  userId: "user-mixed-types",
  entries: [
    {
      delayMs: 0,
      recommendation: "Conservative starting portfolio",
      rationale: "First recommendation for new user",
      targetVault: "vault-agg-conservative",
      changedInputs: ["riskTolerance", "timeHorizon", "liquidityNeeds"],
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 4.5,
        liquidityDepthUsd: 500000,
        volatilityPct: 1.2,
        timeHorizon: "long",
        liquidityNeeds: "low",
      },
    },
    {
      delayMs: 10,
      recommendation: "Shift to balanced portfolio",
      rationale: "User increased risk tolerance after 3 months",
      targetVault: "vault-agg-balanced",
      changedInputs: ["riskTolerance"],
      inputSnapshot: {
        riskTolerance: "balanced",
        expectedApy: 8.2,
        liquidityDepthUsd: 500000,
        volatilityPct: 4.5,
        timeHorizon: "long",
        liquidityNeeds: "low",
      },
    },
    {
      delayMs: 10,
      recommendation: "Rebalance due to APY shift",
      rationale: "Protocol yield rates increased significantly",
      targetVault: "vault-agg-balanced-alt",
      changedInputs: ["expectedApy"],
      inputSnapshot: {
        riskTolerance: "balanced",
        expectedApy: 12.1,
        liquidityDepthUsd: 500000,
        volatilityPct: 4.5,
        timeHorizon: "long",
        liquidityNeeds: "low",
      },
    },
    {
      delayMs: 10,
      recommendation: "Reduce risk due to market volatility",
      rationale: "Market volatility increased to critical levels",
      targetVault: "vault-agg-stable",
      changedInputs: ["volatilityPct"],
      inputSnapshot: {
        riskTolerance: "balanced",
        expectedApy: 10.0,
        liquidityDepthUsd: 500000,
        volatilityPct: 18.5,
        timeHorizon: "long",
        liquidityNeeds: "low",
      },
    },
    {
      delayMs: 10,
      recommendation: "Rebalance for liquidity needs",
      rationale: "User increased near-term liquidity requirements",
      targetVault: "vault-agg-liquid",
      changedInputs: ["liquidityNeeds"],
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 6.5,
        liquidityDepthUsd: 500000,
        volatilityPct: 3.2,
        timeHorizon: "medium",
        liquidityNeeds: "high",
      },
    },
    {
      delayMs: 10,
      recommendation: "Increase liquidity depth to capture better rates",
      rationale: "Liquidity depth improved significantly",
      targetVault: "vault-agg-balanced",
      changedInputs: ["liquidityDepthUsd"],
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 8.9,
        liquidityDepthUsd: 1000000,
        volatilityPct: 3.2,
        timeHorizon: "medium",
        liquidityNeeds: "medium",
      },
    },
  ],
};

/**
 * Fixture: All three risk profiles across market conditions
 * Tests pagination with diverse data representing all user segments
 */
export const ALL_RISK_PROFILES_FIXTURE: RecommendationFixture = {
  name: "all-risk-profiles",
  description: "Recommendations across all risk profiles in various market conditions",
  userId: "user-all-profiles",
  entries: [
    // Conservative user - normal market
    {
      delayMs: 0,
      recommendation: "Conservative USDC-based strategy",
      rationale: "Low risk tolerance, stable market",
      targetVault: "vault-core-usdc",
      changedInputs: ["riskTolerance"],
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 3.5,
        liquidityDepthUsd: 2000000,
        volatilityPct: 1.2,
      },
    },
    // Balanced user - normal market
    {
      delayMs: 5,
      recommendation: "Balanced yield aggregator",
      rationale: "Medium risk tolerance, diversified sources",
      targetVault: "vault-agg-balanced",
      changedInputs: ["riskTolerance"],
      inputSnapshot: {
        riskTolerance: "balanced",
        expectedApy: 8.5,
        liquidityDepthUsd: 5000000,
        volatilityPct: 5.5,
      },
    },
    // Aggressive user - normal market
    {
      delayMs: 5,
      recommendation: "Aggressive high-yield strategy",
      rationale: "High risk tolerance, maximum yield seeking",
      targetVault: "vault-agg-aggressive",
      changedInputs: ["riskTolerance"],
      inputSnapshot: {
        riskTolerance: "aggressive",
        expectedApy: 15.2,
        liquidityDepthUsd: 8000000,
        volatilityPct: 12.1,
      },
    },
    // Conservative user - high volatility market
    {
      delayMs: 5,
      recommendation: "Conservative shift during volatility",
      rationale: "Market volatility spike - reduce exposure",
      targetVault: "vault-core-usdc",
      changedInputs: ["volatilityPct"],
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 2.8,
        liquidityDepthUsd: 2000000,
        volatilityPct: 22.5,
      },
    },
    // Balanced user - high volatility market
    {
      delayMs: 5,
      recommendation: "Balanced rebalance during volatility",
      rationale: "Maintain balance, reduce equity-like holdings",
      targetVault: "vault-agg-stable",
      changedInputs: ["volatilityPct"],
      inputSnapshot: {
        riskTolerance: "balanced",
        expectedApy: 6.2,
        liquidityDepthUsd: 5000000,
        volatilityPct: 22.5,
      },
    },
    // Aggressive user - high volatility market
    {
      delayMs: 5,
      recommendation: "Aggressive - capitalize on volatility",
      rationale: "High volatility creates opportunity",
      targetVault: "vault-agg-aggressive",
      changedInputs: ["volatilityPct"],
      inputSnapshot: {
        riskTolerance: "aggressive",
        expectedApy: 22.5,
        liquidityDepthUsd: 8000000,
        volatilityPct: 22.5,
      },
    },
    // Return to normal market - all profiles
    {
      delayMs: 5,
      recommendation: "Conservative post-volatility",
      rationale: "Volatility decreasing, normalizing strategy",
      targetVault: "vault-agg-conservative",
      changedInputs: ["volatilityPct"],
      inputSnapshot: {
        riskTolerance: "conservative",
        expectedApy: 4.2,
        liquidityDepthUsd: 2000000,
        volatilityPct: 3.5,
      },
    },
    {
      delayMs: 5,
      recommendation: "Balanced post-volatility",
      rationale: "Normalizing to balanced allocation",
      targetVault: "vault-agg-balanced",
      changedInputs: ["volatilityPct"],
      inputSnapshot: {
        riskTolerance: "balanced",
        expectedApy: 8.8,
        liquidityDepthUsd: 5000000,
        volatilityPct: 3.5,
      },
    },
    {
      delayMs: 5,
      recommendation: "Aggressive post-volatility",
      rationale: "Market stabilizing, resume growth strategy",
      targetVault: "vault-agg-aggressive",
      changedInputs: ["volatilityPct"],
      inputSnapshot: {
        riskTolerance: "aggressive",
        expectedApy: 16.1,
        liquidityDepthUsd: 8000000,
        volatilityPct: 3.5,
      },
    },
  ],
};

/**
 * Fixture: Large dataset for pagination stress testing
 * Tests pagination performance with 50+ items
 */
export const LARGE_DATASET_FIXTURE: RecommendationFixture = {
  name: "large-dataset",
  description: "Large dataset with 50 recommendations for pagination stress testing",
  userId: "user-large-dataset",
  entries: Array.from({ length: 50 }, (_, i) => ({
    delayMs: i > 0 ? 1 : 0,
    recommendation: `Recommendation ${50 - i}`,
    rationale: `Generated recommendation ${50 - i}`,
    targetVault: `vault-${i % 5}`,
    changedInputs: [],
    inputSnapshot: {
      riskTolerance: ["conservative", "balanced", "aggressive"][i % 3] as
        | "conservative"
        | "balanced"
        | "aggressive",
      expectedApy: 5 + (i % 20),
      liquidityDepthUsd: 100000 * (1 + (i % 10)),
      volatilityPct: 2 + (i % 10),
    },
  })),
};

/**
 * Helper to apply fixture to storage
 * Simulates realistic timing with optional delays between entries
 */
export async function applyRecommendationFixture(
  fixture: RecommendationFixture,
  recordFn: (
    userId: string,
    payload: any
  ) => Promise<RecommendationTimelineEntry>
): Promise<RecommendationTimelineEntry[]> {
  const recorded: RecommendationTimelineEntry[] = [];

  for (const entry of fixture.entries) {
    const { delayMs, ...payload } = entry;

    if (delayMs && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const recorded_entry = await recordFn(fixture.userId, payload);
    recorded.push(recorded_entry);
  }

  return recorded;
}

/**
 * All available fixtures for testing
 */
export const RECOMMENDATION_FIXTURES = {
  repeatedTimestamps: REPEATED_TIMESTAMPS_FIXTURE,
  mixedTypes: MIXED_TYPES_FIXTURE,
  allRiskProfiles: ALL_RISK_PROFILES_FIXTURE,
  largeDataset: LARGE_DATASET_FIXTURE,
} as const;
