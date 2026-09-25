import type {
  RecommendationInputSnapshot,
  ReasonCode,
} from "../../services/recommendationTimelineService";

export type UserProfile = "conservative" | "balanced" | "aggressive";
export type MarketState = "normal" | "volatile" | "stale";

export interface RecommendationFixtureScenario {
  name: string;
  profile: UserProfile;
  market: MarketState;
  targetVault: string;
  recommendation: string;
  rationale: string;
  inputSnapshot: RecommendationInputSnapshot;
}

export interface RecommendationFixtureCase {
  profile: UserProfile;
  initial: RecommendationFixtureScenario;
  transitions: Array<{
    next: RecommendationFixtureScenario;
    expectedReasonCodes: ReasonCode[];
  }>;
}

export const FIXED_BASE_TIME = "2026-01-01T00:00:00.000Z";

const PROFILE_BASELINE: Record<UserProfile, RecommendationInputSnapshot> = {
  conservative: {
    riskTolerance: "conservative",
    expectedApy: 5.2,
    liquidityDepthUsd: 1_400_000,
    volatilityPct: 2.2,
  },
  balanced: {
    riskTolerance: "balanced",
    expectedApy: 7.8,
    liquidityDepthUsd: 1_000_000,
    volatilityPct: 4.5,
  },
  aggressive: {
    riskTolerance: "aggressive",
    expectedApy: 11.2,
    liquidityDepthUsd: 850_000,
    volatilityPct: 7.1,
  },
};

const TARGET_VAULTS: Record<UserProfile, Record<MarketState, string>> = {
  conservative: {
    normal: "Blend Stable",
    volatile: "DeFindex Shield",
    stale: "Yield Reserve",
  },
  balanced: {
    normal: "DeFindex Index",
    volatile: "Blend Dynamic",
    stale: "Blend Stable",
  },
  aggressive: {
    normal: "Soroswap Momentum",
    volatile: "Aqua Volatility",
    stale: "DeFindex Index",
  },
};

function makeScenario(
  profile: UserProfile,
  market: MarketState,
  overrides: Partial<RecommendationInputSnapshot> = {},
): RecommendationFixtureScenario {
  const inputSnapshot: RecommendationInputSnapshot = {
    ...PROFILE_BASELINE[profile],
    ...overrides,
  };
  return {
    name: `${profile}-${market}`,
    profile,
    market,
    targetVault: TARGET_VAULTS[profile][market],
    recommendation: `Recommendation for ${profile} in ${market} market`,
    rationale: `Reasoning for ${profile} profile under ${market} conditions`,
    inputSnapshot,
  };
}

export const RECOMMENDATION_FIXTURE_CASES: RecommendationFixtureCase[] = [
  {
    profile: "conservative",
    initial: makeScenario("conservative", "normal"),
    transitions: [
      {
        next: makeScenario("conservative", "volatile", {
          expectedApy: 4.4,
          liquidityDepthUsd: 1_320_000,
          volatilityPct: 3.6,
        }),
        expectedReasonCodes: ["apy-shift", "volatility-change"],
      },
      {
        next: makeScenario("conservative", "stale", {
          expectedApy: 4.1,
          liquidityDepthUsd: 1_250_000,
          volatilityPct: 3.7,
        }),
        expectedReasonCodes: ["liquidity-change"],
      },
    ],
  },
  {
    profile: "balanced",
    initial: makeScenario("balanced", "normal"),
    transitions: [
      {
        next: makeScenario("balanced", "volatile", {
          expectedApy: 8.6,
          liquidityDepthUsd: 940_000,
          volatilityPct: 6.1,
        }),
        expectedReasonCodes: ["apy-shift", "volatility-change", "liquidity-change"],
      },
      {
        next: makeScenario("balanced", "stale", {
          expectedApy: 8.5,
          liquidityDepthUsd: 880_000,
          volatilityPct: 6.3,
        }),
        expectedReasonCodes: ["liquidity-change"],
      },
    ],
  },
  {
    profile: "aggressive",
    initial: makeScenario("aggressive", "normal"),
    transitions: [
      {
        next: makeScenario("aggressive", "volatile", {
          riskTolerance: "balanced",
          expectedApy: 10.3,
          liquidityDepthUsd: 770_000,
          volatilityPct: 8.6,
        }),
        expectedReasonCodes: [
          "risk-tolerance-change",
          "apy-shift",
          "volatility-change",
          "liquidity-change",
        ],
      },
      {
        next: makeScenario("aggressive", "stale", {
          riskTolerance: "balanced",
          expectedApy: 10.1,
          liquidityDepthUsd: 710_000,
          volatilityPct: 8.8,
        }),
        expectedReasonCodes: ["liquidity-change"],
      },
    ],
  },
];

export function withDeterministicFixtureClock(fn: () => Promise<void> | void): Promise<void> | void {
  return fn();
}
