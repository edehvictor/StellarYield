import {
  calculateRiskScore,
  tvlScore,
  volatilityScore,
  ageScore,
  type RiskInput,
} from "../utils/riskScoring";

// ── Sub-score unit tests ────────────────────────────────────────────────

describe("tvlScore", () => {
  it("returns 0 for zero TVL", () => {
    expect(tvlScore(0)).toBe(0);
  });

  it("returns 0 for negative TVL", () => {
    expect(tvlScore(-5000)).toBe(0);
  });

  it("increases with TVL", () => {
    expect(tvlScore(10_000)).toBeGreaterThan(tvlScore(1_000));
    expect(tvlScore(100_000)).toBeGreaterThan(tvlScore(10_000));
  });

  it("caps at 10", () => {
    expect(tvlScore(1_000_000_000)).toBe(10);
  });

  it("returns a positive score for small TVL", () => {
    expect(tvlScore(100)).toBeGreaterThan(0);
  });
});

describe("volatilityScore", () => {
  it("returns 10 for zero volatility", () => {
    expect(volatilityScore(0)).toBe(10);
  });

  it("returns 10 for negative volatility (impossible but safe)", () => {
    expect(volatilityScore(-2)).toBe(10);
  });

  it("returns 5 for 5% volatility", () => {
    expect(volatilityScore(5)).toBe(5);
  });

  it("returns 0 for 10%+ volatility", () => {
    expect(volatilityScore(10)).toBe(0);
    expect(volatilityScore(15)).toBe(0);
  });

  it("decreases as volatility increases", () => {
    expect(volatilityScore(2)).toBeGreaterThan(volatilityScore(8));
  });
});

describe("ageScore", () => {
  it("returns 0 for zero-day-old protocol", () => {
    expect(ageScore(0)).toBe(0);
  });

  it("returns 0 for negative age", () => {
    expect(ageScore(-30)).toBe(0);
  });

  it("returns ~5 for 90 days (one quarter)", () => {
    const score = ageScore(90);
    expect(score).toBeGreaterThan(4);
    expect(score).toBeLessThan(6);
  });

  it("returns 10 for 365+ days", () => {
    expect(ageScore(365)).toBe(10);
    expect(ageScore(730)).toBe(10);
  });

  it("increases with age", () => {
    expect(ageScore(180)).toBeGreaterThan(ageScore(30));
  });
});

// ── Integration tests ───────────────────────────────────────────────────

describe("calculateRiskScore", () => {
  it("returns a score between 1 and 10", () => {
    const inputs: RiskInput[] = [
      { tvlUsd: 0, ilVolatilityPct: 50, protocolAgeDays: 0 },
      { tvlUsd: 100_000_000, ilVolatilityPct: 0, protocolAgeDays: 1000 },
      { tvlUsd: 500_000, ilVolatilityPct: 5, protocolAgeDays: 180 },
    ];
    for (const input of inputs) {
      const { score } = calculateRiskScore(input);
      expect(score).toBeGreaterThanOrEqual(1);
      expect(score).toBeLessThanOrEqual(10);
    }
  });

  it('labels high TVL + low volatility + old protocol as "Low" risk', () => {
    const result = calculateRiskScore({
      tvlUsd: 12_000_000,
      ilVolatilityPct: 2,
      protocolAgeDays: 400,
    });
    expect(result.label).toBe("Low");
    expect(result.score).toBeGreaterThanOrEqual(7);
  });

  it('labels low TVL + high volatility + new protocol as "High" risk', () => {
    const result = calculateRiskScore({
      tvlUsd: 1_000,
      ilVolatilityPct: 12,
      protocolAgeDays: 5,
    });
    expect(result.label).toBe("High");
    expect(result.score).toBeLessThan(4);
  });

  it('labels moderate parameters as "Medium" risk', () => {
    const result = calculateRiskScore({
      tvlUsd: 50_000,
      ilVolatilityPct: 6,
      protocolAgeDays: 60,
    });
    expect(result.label).toBe("Medium");
    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.score).toBeLessThan(7);
  });

  it("provides sub-score breakdown", () => {
    const result = calculateRiskScore({
      tvlUsd: 1_000_000,
      ilVolatilityPct: 3,
      protocolAgeDays: 200,
    });
    expect(result.breakdown).toHaveProperty("tvl");
    expect(result.breakdown).toHaveProperty("volatility");
    expect(result.breakdown).toHaveProperty("age");
    expect(result.breakdown.tvl).toBeGreaterThan(0);
    expect(result.breakdown.volatility).toBeGreaterThan(0);
    expect(result.breakdown.age).toBeGreaterThan(0);
  });

  it("handles extreme edge case: all zeros", () => {
    const result = calculateRiskScore({
      tvlUsd: 0,
      ilVolatilityPct: 0,
      protocolAgeDays: 0,
    });
    // TVL=0→0, Vol=0→10, Age=0→0 → weighted = 0.35*10 = 3.5
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(4);
  });

  it("handles extreme volatility gracefully", () => {
    const result = calculateRiskScore({
      tvlUsd: 50_000_000,
      ilVolatilityPct: 100,
      protocolAgeDays: 500,
    });
    // Volatility score clamped to 0, but TVL and age still contribute
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("is deterministic (same input → same output)", () => {
    const input: RiskInput = {
      tvlUsd: 7_500_000,
      ilVolatilityPct: 4.5,
      protocolAgeDays: 250,
    };
    const a = calculateRiskScore(input);
    const b = calculateRiskScore(input);
    expect(a.score).toBe(b.score);
    expect(a.label).toBe(b.label);
  });
});
