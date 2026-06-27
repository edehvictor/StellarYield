/**
 * Confidence Badge Threshold Tests (#836)
 *
 * Tests the `computeConfidenceScore` function's label thresholds,
 * boundary values, malformed inputs, uncertainty bands, and weighted
 * factor contributions.
 *
 * Weights: freshness=0.30, providerAgreement=0.25, liquidityQuality=0.25,
 *          modelCompleteness=0.20 (must sum to 1.0)
 *
 * Label thresholds:
 *   >= 0.85 → "Very High"
 *   >= 0.65 → "High"
 *   >= 0.45 → "Medium"
 *   >= 0.25 → "Low"
 *   < 0.25  → "Very Low"
 */

import { computeConfidenceScore } from "../confidenceService";

describe("computeConfidenceScore – label thresholds", () => {
  it("1. returns 'Very Low' for factors just below the 0.25 boundary", () => {
    // composite = 0.24 * 1.0 = 0.24, which is < 0.25
    const result = computeConfidenceScore({
      freshness: 0.24,
      providerAgreement: 0.24,
      liquidityQuality: 0.24,
      modelCompleteness: 0.24,
    });
    expect(result.score).toBeLessThan(0.25);
    expect(result.label).toBe("Very Low");
  });

  it("2. returns 'Low' for factors at exactly the 0.25 threshold", () => {
    // All factors = 0.25 → composite = 0.25 * 1.0 = 0.25, rounds to 0.25
    const result = computeConfidenceScore({
      freshness: 0.25,
      providerAgreement: 0.25,
      liquidityQuality: 0.25,
      modelCompleteness: 0.25,
    });
    expect(result.score).toBe(0.25);
    expect(result.label).toBe("Low");
  });

  it("3. returns 'Medium' for factors yielding composite ~0.45", () => {
    // All factors = 0.45 → composite = 0.45 * 1.0 = 0.45
    const result = computeConfidenceScore({
      freshness: 0.45,
      providerAgreement: 0.45,
      liquidityQuality: 0.45,
      modelCompleteness: 0.45,
    });
    expect(result.score).toBeGreaterThanOrEqual(0.45);
    expect(result.score).toBeLessThan(0.65);
    expect(result.label).toBe("Medium");
  });

  it("4. returns 'High' for factors yielding composite ~0.65", () => {
    // All factors = 0.65 → composite = 0.65
    const result = computeConfidenceScore({
      freshness: 0.65,
      providerAgreement: 0.65,
      liquidityQuality: 0.65,
      modelCompleteness: 0.65,
    });
    expect(result.score).toBeGreaterThanOrEqual(0.65);
    expect(result.score).toBeLessThan(0.85);
    expect(result.label).toBe("High");
  });

  it("5. returns 'Very High' for all factors = 1.0", () => {
    const result = computeConfidenceScore({
      freshness: 1.0,
      providerAgreement: 1.0,
      liquidityQuality: 1.0,
      modelCompleteness: 1.0,
    });
    expect(result.score).toBe(1.0);
    expect(result.label).toBe("Very High");
    // perfect score → no caveats expected
    expect(result.caveats).toHaveLength(0);
  });
});

describe("computeConfidenceScore – exact boundary values", () => {
  it("6. boundary score = 0.25 exactly → label is 'Low'", () => {
    // All factors equal 0.25 → weighted sum = 0.25 * (0.30+0.25+0.25+0.20) = 0.25
    const result = computeConfidenceScore({
      freshness: 0.25,
      providerAgreement: 0.25,
      liquidityQuality: 0.25,
      modelCompleteness: 0.25,
    });
    expect(result.score).toBe(0.25);
    expect(result.label).toBe("Low");
  });

  it("7. boundary score = 0.65 exactly → label is 'High'", () => {
    // All factors equal 0.65 → weighted sum = 0.65 * 1.0 = 0.65
    const result = computeConfidenceScore({
      freshness: 0.65,
      providerAgreement: 0.65,
      liquidityQuality: 0.65,
      modelCompleteness: 0.65,
    });
    expect(result.score).toBe(0.65);
    expect(result.label).toBe("High");
  });
});

describe("computeConfidenceScore – malformed inputs", () => {
  it("8. clamps factors above 1 so score stays <= 1", () => {
    const result = computeConfidenceScore({
      freshness: 3.0,
      providerAgreement: 10.0,
      liquidityQuality: 2.5,
      modelCompleteness: 5.0,
    });
    expect(result.score).toBeLessThanOrEqual(1);
    // clamped to all-1 → "Very High"
    expect(result.label).toBe("Very High");
    // clamped factors should be recorded as 1
    expect(result.factors.freshness).toBe(1);
    expect(result.factors.providerAgreement).toBe(1);
    expect(result.factors.liquidityQuality).toBe(1);
    expect(result.factors.modelCompleteness).toBe(1);
  });

  it("9. clamps negative factors to 0 → score = 0, label = 'Very Low'", () => {
    const result = computeConfidenceScore({
      freshness: -1.0,
      providerAgreement: -0.5,
      liquidityQuality: -2.0,
      modelCompleteness: -0.1,
    });
    expect(result.score).toBe(0);
    expect(result.label).toBe("Very Low");
    expect(result.factors.freshness).toBe(0);
    expect(result.factors.providerAgreement).toBe(0);
    expect(result.factors.liquidityQuality).toBe(0);
    expect(result.factors.modelCompleteness).toBe(0);
  });
});

describe("computeConfidenceScore – uncertainty bands", () => {
  it("10. bands remain stable: band at score 0.65 is wider than band at score 0.85", () => {
    // score 0.65 → band = max(0.02, (1-0.65)*0.2) = max(0.02, 0.07) = 0.07
    const at065 = computeConfidenceScore({
      freshness: 0.65,
      providerAgreement: 0.65,
      liquidityQuality: 0.65,
      modelCompleteness: 0.65,
    });
    // score 0.85 → band = max(0.02, (1-0.85)*0.2) = max(0.02, 0.03) = 0.03
    const at085 = computeConfidenceScore({
      freshness: 0.85,
      providerAgreement: 0.85,
      liquidityQuality: 0.85,
      modelCompleteness: 0.85,
    });

    expect(at065.uncertaintyBand).toBeGreaterThan(at085.uncertaintyBand);
    // They should be distinct values, not equal
    expect(at065.uncertaintyBand).not.toBeCloseTo(at085.uncertaintyBand, 5);
  });
});

describe("computeConfidenceScore – weighted factor contributions", () => {
  it("11. one factor = 0, rest = 1 reflects weighted contribution", () => {
    // Only freshness = 0, rest = 1
    // score = 0*0.30 + 1*0.25 + 1*0.25 + 1*0.20 = 0.70
    const missingFreshness = computeConfidenceScore({
      freshness: 0,
      providerAgreement: 1,
      liquidityQuality: 1,
      modelCompleteness: 1,
    });
    expect(missingFreshness.score).toBeCloseTo(0.70, 3);
    expect(missingFreshness.label).toBe("High");

    // Only providerAgreement = 0, rest = 1
    // score = 1*0.30 + 0*0.25 + 1*0.25 + 1*0.20 = 0.75
    const missingProviderAgreement = computeConfidenceScore({
      freshness: 1,
      providerAgreement: 0,
      liquidityQuality: 1,
      modelCompleteness: 1,
    });
    expect(missingProviderAgreement.score).toBeCloseTo(0.75, 3);
    expect(missingProviderAgreement.label).toBe("High");

    // Only liquidityQuality = 0, rest = 1
    // score = 1*0.30 + 1*0.25 + 0*0.25 + 1*0.20 = 0.75
    const missingLiquidity = computeConfidenceScore({
      freshness: 1,
      providerAgreement: 1,
      liquidityQuality: 0,
      modelCompleteness: 1,
    });
    expect(missingLiquidity.score).toBeCloseTo(0.75, 3);
    expect(missingLiquidity.label).toBe("High");

    // Only modelCompleteness = 0, rest = 1
    // score = 1*0.30 + 1*0.25 + 1*0.25 + 0*0.20 = 0.80
    const missingCompleteness = computeConfidenceScore({
      freshness: 1,
      providerAgreement: 1,
      liquidityQuality: 1,
      modelCompleteness: 0,
    });
    expect(missingCompleteness.score).toBeCloseTo(0.80, 3);
    expect(missingCompleteness.label).toBe("High");

    // Freshness (weight 0.30) has the biggest single-factor impact
    expect(missingFreshness.score).toBeLessThan(missingCompleteness.score);
  });
});
