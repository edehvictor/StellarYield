import {
  aggregateApy,
  buildPortfolioYieldSummary,
} from "../services/yieldService";
import { normalizeYield } from "../utils/yieldNormalization";
import type { RawProtocolYield } from "../types/yields";

const baseRawYield: RawProtocolYield = {
  protocolName: "Blend",
  protocolType: "blend",
  apyBps: 675,
  tvlUsd: 1_000_000,
  volatilityPct: 2.5,
  protocolAgeDays: 400,
  network: "mainnet",
  source: "stellar://blend",
  fetchedAt: "2026-03-25T10:00:00.000Z",
  liquidityUsd: 500_000,
  rebalancingBehavior: "automated",
  managementFeeBps: 25,
  performanceFeeBps: 150,
  capitalEfficiencyPct: 92,
};

describe("yield normalization boundary hardening", () => {
  it("normal operation emits finite, rounded yield display values", () => {
    const normalized = normalizeYield(baseRawYield);

    expect(normalized.protocolName).toBe("Blend");
    expect(normalized.apy).toBe(6.75);
    expect(normalized.totalApy).toBe(6.75);
    expect(Number.isFinite(normalized.netApy)).toBe(true);
    expect(Number.isFinite(normalized.feeDragApy)).toBe(true);
    expect(normalized.tvl).toBe(1_000_000);
  });

  it("treats zero and near-limit boundary values safely", () => {
    const zero = normalizeYield({
      ...baseRawYield,
      apyBps: 0,
      tvlUsd: 0,
      volatilityPct: 0,
      protocolAgeDays: 0,
      managementFeeBps: 0,
      performanceFeeBps: 0,
      capitalEfficiencyPct: 0,
      rewards: [
        { tokenSymbol: "RWD", emissionPerYear: 100, tokenPrice: 1 },
      ],
    });
    expect(zero.apy).toBe(0);
    expect(zero.rewardApy).toBe(0);
    expect(zero.totalApy).toBe(0);
    expect(zero.tvl).toBe(0);
    expect(Number.isFinite(zero.netApy)).toBe(true);

    const nearMax = normalizeYield({
      ...baseRawYield,
      apyBps: 10_000_000, // 100,000% (clamped upper bound)
      tvlUsd: 1_000_000_000_000_000,
      volatilityPct: 10_000,
      protocolAgeDays: 365_000,
      managementFeeBps: 10_000,
      performanceFeeBps: 10_000,
      capitalEfficiencyPct: 10_000,
    });
    expect(Number.isFinite(nearMax.apy)).toBe(true);
    expect(Number.isFinite(nearMax.totalApy)).toBe(true);
    expect(Number.isFinite(nearMax.netApy)).toBe(true);
    expect(Number.isFinite(nearMax.feeDragApy)).toBe(true);
    expect(Number.isFinite(nearMax.tvl)).toBe(true);
  });

  it("returns a safe finite default for non-finite or invalid raw inputs without throwing", () => {
    const invalidCases: Array<Partial<RawProtocolYield>> = [
      { apyBps: Number.NaN },
      { apyBps: Number.POSITIVE_INFINITY },
      { tvlUsd: -1 },
      { tvlUsd: Number.NaN },
      { volatilityPct: Number.NaN },
      { protocolAgeDays: -5 },
      { managementFeeBps: Number.NaN },
      { performanceFeeBps: Number.POSITIVE_INFINITY },
      { capitalEfficiencyPct: Number.NaN },
    ];

    for (const patch of invalidCases) {
      const normalized = normalizeYield({ ...baseRawYield, ...patch } as RawProtocolYield);
      expect(normalized.protocolName).toBe("Unknown");
      expect(normalized.apy).toBe(0);
      expect(normalized.rewardApy).toBe(0);
      expect(normalized.totalApy).toBe(0);
      expect(normalized.netApy).toBe(0);
      expect(normalized.feeDragApy).toBe(0);
      expect(normalized.tvl).toBe(0);
    }
  });

  it("skips non-finite reward calculations and keeps emitted values finite", () => {
    const normalized = normalizeYield({
      ...baseRawYield,
      rewards: [
        { tokenSymbol: "BAD1", emissionPerYear: Number.NaN, tokenPrice: 1 },
        { tokenSymbol: "BAD2", emissionPerYear: 100, tokenPrice: Number.POSITIVE_INFINITY },
        { tokenSymbol: "GOOD", emissionPerYear: 10_000, tokenPrice: 1 },
      ],
    });

    expect(Number.isFinite(normalized.rewardApy)).toBe(true);
    expect(Number.isFinite(normalized.totalApy)).toBe(true);
    expect(normalized.rewards?.some((r) => r.symbol === "GOOD")).toBe(true);
    expect(normalized.rewards?.some((r) => r.symbol === "BAD1")).toBe(false);
    expect(normalized.rewards?.some((r) => r.symbol === "BAD2")).toBe(false);
  });
});

describe("aggregateApy boundary hardening", () => {
  it("handles non-finite readings and weights without producing NaN", () => {
    const result = aggregateApy(
      [
        { provider: "a", apy: 5, weight: 1 },
        { provider: "b", apy: Number.NaN, weight: 1 },
        { provider: "c", apy: Number.POSITIVE_INFINITY, weight: 2 },
        { provider: "d", apy: 7, weight: Number.NaN },
      ] as any,
      "blend",
    );

    expect(result.consensusApy).not.toBeNull();
    expect(Number.isFinite(result.consensusApy as number)).toBe(true);
    expect(Number.isFinite(result.confidence.score)).toBe(true);
    expect(result.confidence.score).toBeGreaterThanOrEqual(0);
    expect(result.confidence.score).toBeLessThanOrEqual(100);
  });

  it("returns null consensus for empty or fully invalid readings", () => {
    const empty = aggregateApy([], "blend");
    expect(empty.consensusApy).toBeNull();
    expect(empty.confidence.score).toBe(0);

    const invalid = aggregateApy(
      [{ provider: "a", apy: Number.NaN }, { provider: "b", apy: Number.POSITIVE_INFINITY }] as any,
      "blend",
    );
    expect(invalid.consensusApy).toBeNull();
    expect(invalid.confidence.score).toBe(0);
  });
});

describe("portfolio yield summary boundary hardening", () => {
  it("produces finite blended display values for zero, non-finite, and near-limit positions", () => {
    const feed = [
      {
        protocolName: "Blend",
        apy: 6.75,
        rewardApy: 0.25,
        totalApy: 7,
        netApy: 6.5,
        tvl: 1_000_000,
      },
      {
        protocolName: "Soroswap",
        apy: 10,
        rewardApy: 0,
        totalApy: 10,
        netApy: 9.2,
        tvl: 2_000_000,
      },
    ] as any;

    const summary = buildPortfolioYieldSummary(
      [
        { protocol: "Blend", valueUsd: 0 },
        { protocol: "Blend", valueUsd: Number.NaN },
        { protocol: "Soroswap", valueUsd: Number.POSITIVE_INFINITY },
        { protocol: "Soroswap", valueUsd: 1_000_000_000_000_000 },
        { protocol: "Missing", valueUsd: 100 },
      ],
      feed,
    );

    expect(summary.unpricedProtocols).toEqual(["Missing"]);
    expect(Number.isFinite(summary.totalValueUsd)).toBe(true);
    expect(Number.isFinite(summary.blendedApy)).toBe(true);
    expect(Number.isFinite(summary.blendedRewardApy)).toBe(true);
    expect(Number.isFinite(summary.blendedTotalApy)).toBe(true);
    expect(Number.isFinite(summary.blendedNetApy)).toBe(true);
    for (const position of summary.positions) {
      expect(Number.isFinite(position.valueUsd)).toBe(true);
      expect(Number.isFinite(position.weightPct)).toBe(true);
      expect(Number.isFinite(position.contributionApy)).toBe(true);
    }
  });
});
