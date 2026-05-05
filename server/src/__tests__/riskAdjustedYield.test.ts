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
