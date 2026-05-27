import {
  computeFreshnessScore,
  computeProviderAgreement,
  computeLiquidityScore,
  computeModelCompleteness,
  computeConfidenceScore,
  computeDecayedFreshnessConfidence,
} from "../confidenceService";

describe("computeFreshnessScore", () => {
  it("returns 1.0 for data < 60 s old", () => {
    expect(computeFreshnessScore(30_000)).toBe(1.0);
    expect(computeFreshnessScore(0)).toBe(1.0);
  });
  it("returns 0.0 for data >= 10 min old", () => {
    expect(computeFreshnessScore(10 * 60 * 1_000)).toBe(0.0);
    expect(computeFreshnessScore(15 * 60 * 1_000)).toBe(0.0);
  });
  it("returns intermediate value for 5 min old data", () => {
    const score = computeFreshnessScore(5 * 60 * 1_000);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe("computeProviderAgreement", () => {
  it("returns 0 for empty array", () => {
    expect(computeProviderAgreement([])).toBe(0);
  });
  it("returns 0.5 for single provider", () => {
    expect(computeProviderAgreement([5])).toBe(0.5);
  });
  it("returns 1.0 for identical yields from multiple providers", () => {
    expect(computeProviderAgreement([5, 5, 5])).toBe(1.0);
  });
  it("returns lower score for high variance", () => {
    const highVar = computeProviderAgreement([1, 10, 100]);
    const lowVar  = computeProviderAgreement([5, 5.1, 5.2]);
    expect(highVar).toBeLessThan(lowVar);
  });
  it("returns >= 0 (never negative)", () => {
    expect(computeProviderAgreement([1, 1000])).toBeGreaterThanOrEqual(0);
  });
});

describe("computeLiquidityScore", () => {
  it("returns 0 for zero TVL", () => {
    expect(computeLiquidityScore(0)).toBe(0);
  });
  it("returns 1.0 for TVL >= $1M", () => {
    expect(computeLiquidityScore(1_000_000)).toBe(1.0);
    expect(computeLiquidityScore(5_000_000)).toBe(1.0);
  });
  it("returns intermediate value for TVL between $10k and $1M", () => {
    const score = computeLiquidityScore(100_000);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
  it("returns 0 for TVL below $10k", () => {
    expect(computeLiquidityScore(5_000)).toBe(0);
  });
});

describe("computeModelCompleteness", () => {
  it("returns 1.0 when all fields are present", () => {
    expect(computeModelCompleteness(["a", "b"], ["a", "b", "c"])).toBe(1.0);
  });
  it("returns 0.5 when half fields are missing", () => {
    expect(computeModelCompleteness(["a", "b"], ["a"])).toBe(0.5);
  });
  it("returns 0 when no fields are present", () => {
    expect(computeModelCompleteness(["a", "b"], [])).toBe(0);
  });
  it("returns 1.0 for empty required list", () => {
    expect(computeModelCompleteness([], [])).toBe(1.0);
  });
});

describe("computeConfidenceScore", () => {
  it("returns score in [0, 1] for all valid inputs", () => {
    const result = computeConfidenceScore({
      freshness: 0.9,
      providerAgreement: 0.8,
      liquidityQuality: 0.7,
      modelCompleteness: 1.0,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("returns 'Very High' label for near-perfect inputs", () => {
    const result = computeConfidenceScore({
      freshness: 1.0,
      providerAgreement: 1.0,
      liquidityQuality: 1.0,
      modelCompleteness: 1.0,
    });
    expect(result.label).toBe("Very High");
    expect(result.caveats).toHaveLength(0);
  });

  it("returns 'Very Low' label for all-zero inputs", () => {
    const result = computeConfidenceScore({
      freshness: 0,
      providerAgreement: 0,
      liquidityQuality: 0,
      modelCompleteness: 0,
    });
    expect(result.label).toBe("Very Low");
  });

  it("clamps factor inputs above 1 to 1", () => {
    const result = computeConfidenceScore({
      freshness: 2.0,
      providerAgreement: 5.0,
      liquidityQuality: 1.0,
      modelCompleteness: 1.0,
    });
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("adds caveats for missing data", () => {
    const result = computeConfidenceScore({
      freshness: 0.1,
      providerAgreement: 0.1,
      liquidityQuality: 0.1,
      modelCompleteness: 0.1,
    });
    expect(result.caveats.length).toBeGreaterThan(0);
  });

  it("uncertainty band is narrower for high confidence", () => {
    const high = computeConfidenceScore({ freshness: 1, providerAgreement: 1, liquidityQuality: 1, modelCompleteness: 1 });
    const low  = computeConfidenceScore({ freshness: 0, providerAgreement: 0, liquidityQuality: 0, modelCompleteness: 0 });
    expect(high.uncertaintyBand).toBeLessThan(low.uncertaintyBand);
  });
});

describe("computeDecayedFreshnessConfidence", () => {
  it("returns full confidence in fresh window", () => {
    const result = computeDecayedFreshnessConfidence(30_000);
    expect(result.confidence).toBe(1);
    expect(result.unusable).toBe(false);
  });

  it("decays confidence over time", () => {
    const earlier = computeDecayedFreshnessConfidence(2 * 60_000);
    const later = computeDecayedFreshnessConfidence(8 * 60_000);
    expect(earlier.confidence).toBeGreaterThan(later.confidence);
  });

  it("becomes unusable at hard stale threshold", () => {
    const stale = computeDecayedFreshnessConfidence(50 * 60_000);
    expect(stale.confidence).toBe(0);
    expect(stale.unusable).toBe(true);
  });
});
