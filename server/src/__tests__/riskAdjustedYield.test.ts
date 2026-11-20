import {
  computeRiskAdjustedYield,
  rankStrategies,
  filterByTimeWindow,
  type StrategyInput,
} from "../services/riskAdjustedYieldService";

const makeStrategy = (overrides: Partial<StrategyInput> = {}): StrategyInput => ({
  id: "test",
  name: "Test Strategy",
  strategyType: "blend",
  apy: 10,
  tvlUsd: 1_000_000,
  ilVolatilityPct: 2,
  riskScore: 8,
  fetchedAt: new Date().toISOString(),
  ...overrides,
});

describe("computeRiskAdjustedYield", () => {
  it("returns a positive number for valid input", () => {
    const ray = computeRiskAdjustedYield(makeStrategy());
    expect(ray).toBeGreaterThan(0);
  });

  it("higher riskScore produces higher RAY (same APY and volatility)", () => {
    const low = computeRiskAdjustedYield(makeStrategy({ riskScore: 3 }));
    const high = computeRiskAdjustedYield(makeStrategy({ riskScore: 9 }));
    expect(high).toBeGreaterThan(low);
  });

  it("higher apy produces higher RAY (same risk and volatility)", () => {
    const low = computeRiskAdjustedYield(makeStrategy({ apy: 5 }));
    const high = computeRiskAdjustedYield(makeStrategy({ apy: 15 }));
    expect(high).toBeGreaterThan(low);
  });

  it("higher volatility reduces RAY (same APY and risk)", () => {
    const low = computeRiskAdjustedYield(makeStrategy({ ilVolatilityPct: 8 }));
    const high = computeRiskAdjustedYield(makeStrategy({ ilVolatilityPct: 1 }));
    expect(high).toBeGreaterThan(low);
  });

  it("returns 0 for non-finite inputs", () => {
    expect(computeRiskAdjustedYield(makeStrategy({ apy: NaN }))).toBe(0);
    expect(computeRiskAdjustedYield(makeStrategy({ riskScore: NaN }))).toBe(0);
    expect(computeRiskAdjustedYield(makeStrategy({ ilVolatilityPct: NaN }))).toBe(0);
  });

  it("zero apy yields RAY of 0", () => {
    expect(computeRiskAdjustedYield(makeStrategy({ apy: 0 }))).toBe(0);
  });

  it("is deterministic", () => {
    const s = makeStrategy({ apy: 7.5, riskScore: 6, ilVolatilityPct: 3 });
    expect(computeRiskAdjustedYield(s)).toBe(computeRiskAdjustedYield(s));
  });
});

describe("rankStrategies", () => {
  it("rank 1 has the highest RAY", () => {
    const strategies: StrategyInput[] = [
      makeStrategy({ id: "a", apy: 5, riskScore: 5, ilVolatilityPct: 5 }),
      makeStrategy({ id: "b", apy: 15, riskScore: 9, ilVolatilityPct: 1 }),
      makeStrategy({ id: "c", apy: 8, riskScore: 7, ilVolatilityPct: 3 }),
    ];
    const ranked = rankStrategies(strategies);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[0].id).toBe("b");
  });

  it("assigns sequential ranks", () => {
    const strategies = [
      makeStrategy({ id: "a" }),
      makeStrategy({ id: "b", apy: 20 }),
      makeStrategy({ id: "c", apy: 5 }),
    ];
    const ranked = rankStrategies(strategies);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("tie resolution: equal RAY → higher TVL wins", () => {
    const base = { apy: 10, riskScore: 8, ilVolatilityPct: 2 };
    const strategies: StrategyInput[] = [
      makeStrategy({ id: "low-tvl", ...base, tvlUsd: 100_000 }),
      makeStrategy({ id: "high-tvl", ...base, tvlUsd: 5_000_000 }),
    ];
    const ranked = rankStrategies(strategies);
    expect(ranked[0].id).toBe("high-tvl");
  });

  it("handles empty array", () => {
    expect(rankStrategies([])).toEqual([]);
  });

  it("handles single strategy at rank 1", () => {
    const ranked = rankStrategies([makeStrategy({ id: "solo" })]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].rank).toBe(1);
  });

  it("riskAdjustedYield is included in output", () => {
    const ranked = rankStrategies([makeStrategy()]);
    expect(typeof ranked[0].riskAdjustedYield).toBe("number");
  });

  it("drawdownProxy is included in output", () => {
    const ranked = rankStrategies([makeStrategy({ ilVolatilityPct: 4 })]);
    expect(ranked[0].drawdownProxy).toBeCloseTo(0.4);
  });

  it.each(["conservative", "balanced", "tolerant"] as const)(
    "rankStrategies honors %s drawdown profile",
    (profile) => {
      const strategies = [
        makeStrategy({ id: "high-vol", ilVolatilityPct: 15, apy: 20, riskScore: 5 }),
        makeStrategy({ id: "low-vol", ilVolatilityPct: 2, apy: 8, riskScore: 9 }),
      ];
      const ranked = rankStrategies(strategies, profile);
      expect(ranked[0].rank).toBe(1);
      expect(ranked[0].drawdownMultiplier).toBeDefined();
    },
  );
});

describe("filterByTimeWindow", () => {
  const recentIso = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const oldIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

  it("all returns everything", () => {
    const items = [
      makeStrategy({ fetchedAt: recentIso }),
      makeStrategy({ fetchedAt: oldIso }),
    ];
    expect(filterByTimeWindow(items, "all")).toHaveLength(2);
  });

  it("24h filters out old items", () => {
    const items = [
      makeStrategy({ fetchedAt: recentIso }),
      makeStrategy({ fetchedAt: oldIso }),
    ];
    const result = filterByTimeWindow(items, "24h");
    expect(result).toHaveLength(1);
    expect(result[0].fetchedAt).toBe(recentIso);
  });

  it("includes items without fetchedAt when window is set", () => {
    const items = [makeStrategy({ fetchedAt: undefined })];
    expect(filterByTimeWindow(items, "7d")).toHaveLength(1);
  });
});

describe("tie-breaking and deterministic ranking", () => {
  it("equal RAY and TVL resolves by id alphabetically", () => {
    const base = { apy: 10, riskScore: 8, ilVolatilityPct: 2, tvlUsd: 1_000_000 };
    const strategies: StrategyInput[] = [
      makeStrategy({ id: "zebra", ...base }),
      makeStrategy({ id: "alpha", ...base }),
      makeStrategy({ id: "middle", ...base }),
    ];
    const ranked = rankStrategies(strategies);
    expect(ranked[0].id).toBe("alpha");
    expect(ranked[1].id).toBe("middle");
    expect(ranked[2].id).toBe("zebra");
  });

  it("ranking is stable across repeated calls", () => {
    const strategies: StrategyInput[] = [
      makeStrategy({ id: "a", apy: 10, riskScore: 8, ilVolatilityPct: 2, tvlUsd: 500_000 }),
      makeStrategy({ id: "b", apy: 10, riskScore: 8, ilVolatilityPct: 2, tvlUsd: 500_000 }),
      makeStrategy({ id: "c", apy: 12, riskScore: 7, ilVolatilityPct: 3, tvlUsd: 200_000 }),
    ];

    const first = rankStrategies(strategies);
    const second = rankStrategies(strategies);
    const third = rankStrategies(strategies);

    expect(first.map((s) => s.id)).toEqual(second.map((s) => s.id));
    expect(second.map((s) => s.id)).toEqual(third.map((s) => s.id));
  });

  it("secondary sort key is TVL descending when RAY is equal", () => {
    const base = { apy: 10, riskScore: 8, ilVolatilityPct: 2 };
    const strategies: StrategyInput[] = [
      makeStrategy({ id: "small", ...base, tvlUsd: 100_000 }),
      makeStrategy({ id: "large", ...base, tvlUsd: 5_000_000 }),
      makeStrategy({ id: "medium", ...base, tvlUsd: 1_000_000 }),
    ];
    const ranked = rankStrategies(strategies);
    expect(ranked[0].id).toBe("large");
    expect(ranked[1].id).toBe("medium");
    expect(ranked[2].id).toBe("small");
  });

  it("tertiary sort key is id ascending when RAY and TVL are equal", () => {
    const base = { apy: 10, riskScore: 8, ilVolatilityPct: 2, tvlUsd: 1_000_000 };
    const strategies: StrategyInput[] = [
      makeStrategy({ id: "soroswap", ...base }),
      makeStrategy({ id: "blend", ...base }),
      makeStrategy({ id: "defindex", ...base }),
    ];
    const ranked = rankStrategies(strategies);
    expect(ranked.map((s) => s.id)).toEqual(["blend", "defindex", "soroswap"]);
  });

  it("handles many tied strategies deterministically", () => {
    const base = { apy: 8, riskScore: 7, ilVolatilityPct: 3, tvlUsd: 500_000 };
    const ids = ["g", "a", "f", "b", "e", "c", "d"];
    const strategies = ids.map((id) => makeStrategy({ id, ...base }));
    const ranked = rankStrategies(strategies);
    expect(ranked.map((s) => s.id)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("mixed ties and non-ties produce correct ordering", () => {
    const tied = { apy: 10, riskScore: 8, ilVolatilityPct: 2, tvlUsd: 1_000_000 };
    const strategies: StrategyInput[] = [
      makeStrategy({ id: "winner", apy: 20, riskScore: 9, ilVolatilityPct: 1, tvlUsd: 500_000 }),
      makeStrategy({ id: "tied-b", ...tied }),
      makeStrategy({ id: "tied-a", ...tied }),
      makeStrategy({ id: "loser", apy: 2, riskScore: 3, ilVolatilityPct: 8, tvlUsd: 10_000_000 }),
    ];
    const ranked = rankStrategies(strategies);
    expect(ranked[0].id).toBe("winner");
    expect(ranked[1].id).toBe("tied-a");
    expect(ranked[2].id).toBe("tied-b");
    expect(ranked[3].id).toBe("loser");
  });

  it("ranks are always sequential starting from 1", () => {
    const strategies = Array.from({ length: 10 }, (_, i) =>
      makeStrategy({ id: `s-${i}`, apy: 10 - i, tvlUsd: 100_000 * (i + 1) }),
    );
    const ranked = rankStrategies(strategies);
    expect(ranked.map((s) => s.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
