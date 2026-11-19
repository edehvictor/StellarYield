import { describe, it, expect } from "vitest";
import { sortStrategies } from "./strategySort";
import type { StrategyComparison } from "./types";

function makeStrategy(
  id: string,
  apy: number,
  riskScore: number | null,
  volatilityPct: number | null = null,
  liquidityUsd: number | null = null,
): StrategyComparison {
  return {
    id,
    name: id,
    strategyType: "blend",
    apy,
    risk:
      riskScore !== null
        ? {
            riskScore,
            riskLabel: riskScore >= 7 ? "Low" : riskScore >= 4 ? "Medium" : "High",
            volatilityPct,
            liquidityUsd,
            freshness: "fresh",
            lastFetchedAt: new Date().toISOString(),
          }
        : null,
  };
}

describe("sortStrategies — apy", () => {
  it("sorts by apy descending by default", () => {
    const input = [makeStrategy("a", 5, 7), makeStrategy("b", 12, 6), makeStrategy("c", 8, 9)];
    const sorted = sortStrategies(input, "apy", "desc");
    expect(sorted.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts by apy ascending when requested", () => {
    const input = [makeStrategy("a", 5, 7), makeStrategy("b", 12, 6), makeStrategy("c", 8, 9)];
    const sorted = sortStrategies(input, "apy", "asc");
    expect(sorted.map((s) => s.id)).toEqual(["a", "c", "b"]);
  });
});

describe("sortStrategies — null handling", () => {
  it("places strategies with null riskScore at the bottom", () => {
    const input = [
      makeStrategy("no-score", 10, null),
      makeStrategy("mid", 8, 5),
      makeStrategy("high", 6, 8),
    ];
    const sorted = sortStrategies(input, "riskScore", "desc");
    expect(sorted[sorted.length - 1].id).toBe("no-score");
  });

  it("places both null-score strategies at the bottom, keeping their relative order", () => {
    const input = [
      makeStrategy("a", 10, null),
      makeStrategy("b", 8, 5),
      makeStrategy("c", 6, null),
    ];
    const sorted = sortStrategies(input, "riskScore", "desc");
    const ids = sorted.map((s) => s.id);
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("a"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
  });

  it("uses apy as tie-breaker when riskScores are equal", () => {
    const input = [makeStrategy("low-apy", 5, 7), makeStrategy("high-apy", 10, 7)];
    const sorted = sortStrategies(input, "riskScore", "desc");
    expect(sorted[0].id).toBe("high-apy");
  });

  it("does not mutate the original array", () => {
    const input = [makeStrategy("a", 5, 7), makeStrategy("b", 12, null)];
    const original = [...input];
    sortStrategies(input, "apy", "desc");
    expect(input).toEqual(original);
  });
});

describe("sortStrategies — volatility and liquidity", () => {
  it("sorts by volatility ascending correctly", () => {
    const input = [
      makeStrategy("high-vol", 8, 5, 10),
      makeStrategy("low-vol", 8, 7, 2),
      makeStrategy("no-vol", 9, null, null),
    ];
    const sorted = sortStrategies(input, "volatilityPct", "asc");
    expect(sorted[0].id).toBe("low-vol");
    expect(sorted[sorted.length - 1].id).toBe("no-vol");
  });

  it("sorts by liquidityUsd descending correctly", () => {
    const input = [
      makeStrategy("small", 8, 5, 2, 10_000),
      makeStrategy("large", 6, 7, 3, 5_000_000),
      makeStrategy("none", 12, null, null, null),
    ];
    const sorted = sortStrategies(input, "liquidityUsd", "desc");
    expect(sorted[0].id).toBe("large");
    expect(sorted[sorted.length - 1].id).toBe("none");
  });
});
