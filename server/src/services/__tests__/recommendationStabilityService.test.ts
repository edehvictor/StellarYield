import {
  compareRecommendationSets,
  generateRecommendationStabilityReport,
  type RecommendationOutput,
} from "../recommendationStabilityService";

describe("recommendationStabilityService (#367)", () => {
  const before: RecommendationOutput[] = [
    { id: "vaultA", rank: 1, score: 0.5, confidence: 0.8 },
    { id: "vaultB", rank: 2, score: 0.4, confidence: 0.7 },
  ];

  const after: RecommendationOutput[] = [
    { id: "vaultA", rank: 4, score: 0.2, confidence: 0.5 }, // large rank/score/conf shift
    { id: "vaultB", rank: 2, score: 0.41, confidence: 0.68 }, // small changes
    { id: "vaultC", rank: 1, score: 0.9, confidence: 0.95 }, // missing in before
  ];

  it("flags large changes and sorts them", () => {
    const changes = compareRecommendationSets(before, after, {
      rankChangeThreshold: 3,
      scoreChangeThreshold: 0.1,
      confidenceChangeThreshold: 0.1,
      topK: 10,
    });

    const vaultA = changes.find((c) => c.id === "vaultA");
    const vaultC = changes.find((c) => c.id === "vaultC");

    expect(vaultA).toBeDefined();
    expect(vaultA?.isLargeChange).toBe(true);

    expect(vaultC).toBeDefined();
    expect(vaultC?.before).toBeNull();
    expect(vaultC?.after).not.toBeNull();
    expect(vaultC?.isLargeChange).toBe(true);

    // The most unstable item by rank delta should come first.
    expect(changes[0].id).toBe("vaultA");
  });

  it("generates a stability report with summary + topChanges", () => {
    const report = generateRecommendationStabilityReport(
      before,
      after,
      { testSetId: "ts-1", beforeRelease: "v1", afterRelease: "v2" },
      { topK: 2, rankChangeThreshold: 3, scoreChangeThreshold: 0.1, confidenceChangeThreshold: 0.1 },
    );

    expect(report.baseline.testSetId).toBe("ts-1");
    expect(report.summary.totalItems).toBe(3);
    expect(report.summary.largeChanges).toBeGreaterThan(0);
    expect(report.summary.stabilityScore).toBeGreaterThanOrEqual(0);
    expect(report.summary.stabilityScore).toBeLessThanOrEqual(1);

    expect(report.topChanges.length).toBeLessThanOrEqual(2);
    expect(report.topChanges.every((c) => c.isLargeChange)).toBe(true);
  });
});

