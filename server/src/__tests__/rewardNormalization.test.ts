import { normalizeYield } from "../utils/yieldNormalization";
import type { RawProtocolYield } from "../types/yields";

describe("Reward Normalization", () => {
  const baseRawYield: RawProtocolYield = {
    protocolName: "Test Protocol",
    protocolType: "blend",
    apyBps: 500, // 5%
    tvlUsd: 1_000_000,
    volatilityPct: 2.0,
    protocolAgeDays: 365,
    network: "mainnet",
    source: "test",
    fetchedAt: new Date().toISOString(),
  };

  it("should normalize yield with no rewards", () => {
    const result = normalizeYield(baseRawYield);
    expect(result.apy).toBe(5);
    expect(result.rewardApy).toBe(0);
    expect(result.totalApy).toBe(5);
    expect(result.rewards).toHaveLength(0);
  });

  it("should normalize yield with single reward stream", () => {
    const rawYield: RawProtocolYield = {
      ...baseRawYield,
      rewards: [
        {
          tokenSymbol: "REW",
          emissionPerYear: 100_000,
          tokenPrice: 0.5, // 50,000 USD / 1,000,000 TVL = 5%
        },
      ],
    };
    const result = normalizeYield(rawYield);
    expect(result.apy).toBe(5);
    expect(result.rewardApy).toBe(5);
    expect(result.totalApy).toBe(10);
    expect(result.rewards).toContainEqual({ symbol: "REW", apy: 5 });
  });

  it("should normalize yield with multiple reward streams", () => {
    const rawYield: RawProtocolYield = {
      ...baseRawYield,
      rewards: [
        {
          tokenSymbol: "REW1",
          emissionPerYear: 100_000,
          tokenPrice: 0.5, // 5%
        },
        {
          tokenSymbol: "REW2",
          emissionPerYear: 50_000,
          tokenPrice: 1.0, // 5%
        },
      ],
    };
    const result = normalizeYield(rawYield);
    expect(result.rewardApy).toBe(10);
    expect(result.totalApy).toBe(15);
    expect(result.rewards).toHaveLength(2);
  });

  it("should handle missing or zero token prices gracefully", () => {
    const rawYield: RawProtocolYield = {
      ...baseRawYield,
      rewards: [
        {
          tokenSymbol: "STALE",
          emissionPerYear: 100_000,
          tokenPrice: 0,
        },
        {
          tokenSymbol: "GOOD",
          emissionPerYear: 100_000,
          tokenPrice: 0.5, // 5%
        },
      ],
    };
    const result = normalizeYield(rawYield);
    expect(result.rewardApy).toBe(5);
    expect(result.rewards).toHaveLength(1);
    expect(result.rewards?.[0].symbol).toBe("GOOD");
  });

  it("should handle zero TVL gracefully", () => {
    const rawYield: RawProtocolYield = {
      ...baseRawYield,
      tvlUsd: 0,
      rewards: [
        {
          tokenSymbol: "REW",
          emissionPerYear: 100_000,
          tokenPrice: 0.5,
        },
      ],
    };
    const result = normalizeYield(rawYield);
    expect(result.rewardApy).toBe(0);
    expect(result.totalApy).toBe(5);
  });
});
