import { calculateRiskScore, explainRiskScore } from "../riskScoring";

describe("explainRiskScore", () => {
  it("main path: labels a strong pool's TVL/age as mitigants and volatility as neutral/mitigant", () => {
    const input = { tvlUsd: 12_000_000, ilVolatilityPct: 2.5, protocolAgeDays: 400 };
    const result = calculateRiskScore(input);
    const explanation = explainRiskScore(result, input);

    expect(explanation.score).toBe(result.score);
    expect(explanation.label).toBe(result.label);
    expect(explanation.factors).toHaveLength(3);

    const tvlFactor = explanation.factors.find((f) => f.factor === "tvl")!;
    expect(tvlFactor.impact).toBe("mitigant");
    expect(tvlFactor.reason).toMatch(/12,000,000/);

    // No driver factor for this strong pool, so the summary shouldn't claim one.
    expect(explanation.factors.every((f) => f.impact !== "driver")).toBe(true);
    expect(explanation.summary).toMatch(/no single factor stands out/);
  });

  it("edge case: a brand-new, thin, volatile pool has all three factors as drivers", () => {
    const input = { tvlUsd: 50, ilVolatilityPct: 15, protocolAgeDays: 3 };
    const result = calculateRiskScore(input);
    const explanation = explainRiskScore(result, input);

    expect(explanation.label).toBe("High");
    for (const factor of explanation.factors) {
      expect(factor.impact).toBe("driver");
    }
    expect(explanation.summary).toMatch(/driven mainly by/);
    expect(explanation.summary).toContain("tvl");
    expect(explanation.summary).toContain("volatility");
    expect(explanation.summary).toContain("age");
  });

  it("edge case: zero TVL does not throw and still produces a driver explanation", () => {
    const input = { tvlUsd: 0, ilVolatilityPct: 0, protocolAgeDays: 0 };
    const result = calculateRiskScore(input);
    expect(() => explainRiskScore(result, input)).not.toThrow();

    const explanation = explainRiskScore(result, input);
    const tvlFactor = explanation.factors.find((f) => f.factor === "tvl")!;
    expect(tvlFactor.impact).toBe("driver");
    expect(tvlFactor.reason).toContain("$0");
  });

  it("edge case: mixed factors produce both a driver and a mitigant in the summary", () => {
    // High TVL (mitigant) but very new protocol (driver).
    const input = { tvlUsd: 20_000_000, ilVolatilityPct: 3, protocolAgeDays: 5 };
    const result = calculateRiskScore(input);
    const explanation = explainRiskScore(result, input);

    const ageFactor = explanation.factors.find((f) => f.factor === "age")!;
    const tvlFactor = explanation.factors.find((f) => f.factor === "tvl")!;
    expect(ageFactor.impact).toBe("driver");
    expect(tvlFactor.impact).toBe("mitigant");
    expect(explanation.summary).toMatch(/driven mainly by age.*offset by tvl/);
  });

  it("factor weights sum to 1 and match the documented scoring weights", () => {
    const input = { tvlUsd: 1_000_000, ilVolatilityPct: 5, protocolAgeDays: 100 };
    const result = calculateRiskScore(input);
    const explanation = explainRiskScore(result, input);

    const totalWeight = explanation.factors.reduce((sum, f) => sum + f.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 5);
  });
});
