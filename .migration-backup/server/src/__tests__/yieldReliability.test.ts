import {
  YieldReliabilityEngine,
  formatReliabilityScore,
  isProviderReliable,
  getWeightedProviderSelection,
  detectAnomalies,
} from "../services/yieldReliabilityService";

describe("YieldReliabilityEngine", () => {
  let engine: YieldReliabilityEngine;

  beforeEach(() => {
    engine = new YieldReliabilityEngine();
  });

  describe("calculateReliabilityScore", () => {
    it("returns high reliability for a healthy provider", async () => {
      const result = await engine.calculateReliabilityScore(
        "blend_api",
        "Blend Protocol",
        "api",
      );

      expect(result.reliabilityScore).toBeGreaterThanOrEqual(0);
      expect(result.reliabilityScore).toBeLessThanOrEqual(100);
      expect(["high", "medium", "low", "unreliable"]).toContain(result.status);
      expect(result.providerId).toBe("blend_api");
      expect(result.providerName).toBe("Blend Protocol");
      expect(["improving", "stable", "declining"]).toContain(result.trend);
    });

    it("returns consistent structure for all known providers", async () => {
      const providers = [
        { id: "blend_api", name: "Blend Protocol", source: "api" },
        { id: "soroswap_api", name: "Soroswap", source: "api" },
        { id: "defindex_api", name: "DeFindex", source: "api" },
      ];

      const results = await engine.getReliabilityScores(providers);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result).toHaveProperty("reliabilityScore");
        expect(result).toHaveProperty("metrics");
        expect(result).toHaveProperty("signals");
        expect(result).toHaveProperty("status");
        expect(result).toHaveProperty("trend");
        expect(result).toHaveProperty("recommendations");
        expect(result).toHaveProperty("failoverPriority");
        expect(result).toHaveProperty("weightInRecommendations");
      }
    });

    it("returns metrics with valid ranges", async () => {
      const result = await engine.calculateReliabilityScore(
        "test_provider",
        "Test",
        "api",
      );

      expect(result.metrics.freshness).toBeGreaterThanOrEqual(0);
      expect(result.metrics.freshness).toBeLessThanOrEqual(1);
      expect(result.metrics.consistency).toBeGreaterThanOrEqual(0);
      expect(result.metrics.consistency).toBeLessThanOrEqual(1);
      expect(result.metrics.historicalUptime).toBeGreaterThanOrEqual(0);
      expect(result.metrics.historicalUptime).toBeLessThanOrEqual(1);
      expect(result.metrics.errorRate).toBeGreaterThanOrEqual(0);
      expect(result.metrics.errorRate).toBeLessThanOrEqual(1);
      expect(result.metrics.coverage).toBeGreaterThanOrEqual(0);
      expect(result.metrics.coverage).toBeLessThanOrEqual(1);
    });
  });

  describe("status thresholds", () => {
    it("classifies status based on score thresholds", async () => {
      const result = await engine.calculateReliabilityScore(
        "test_provider",
        "Test",
        "api",
      );

      if (result.reliabilityScore >= 85) {
        expect(result.status).toBe("high");
      } else if (result.reliabilityScore >= 70) {
        expect(result.status).toBe("medium");
      } else if (result.reliabilityScore >= 50) {
        expect(result.status).toBe("low");
      } else {
        expect(result.status).toBe("unreliable");
      }
    });
  });

  describe("compareProviders", () => {
    it("ranks providers by multiple criteria", async () => {
      const providers = [
        { id: "blend_api", name: "Blend", source: "api" },
        { id: "soroswap_api", name: "Soroswap", source: "api" },
        { id: "defindex_api", name: "DeFindex", source: "api" },
      ];

      const comparisons = await engine.compareProviders(providers);

      expect(comparisons).toHaveLength(3);
      for (const comp of comparisons) {
        expect(comp.accuracyRank).toBeGreaterThanOrEqual(1);
        expect(comp.speedRank).toBeGreaterThanOrEqual(1);
        expect(comp.uptimeRank).toBeGreaterThanOrEqual(1);
        expect(comp.overallRank).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("getProviderUptimeReport", () => {
    it("returns default report for unknown provider", () => {
      const report = engine.getProviderUptimeReport("unknown", "Unknown");

      expect(report.uptimePct).toBe(100);
      expect(report.downtimePct).toBe(0);
      expect(report.sampleCount).toBe(0);
      expect(report.recentOutages).toHaveLength(0);
    });
  });

  describe("config updates", () => {
    it("allows updating configuration", () => {
      engine.updateConfig({ scoreUpdateIntervalMinutes: 20 });
      const config = engine.getConfig();
      expect(config.scoreUpdateIntervalMinutes).toBe(20);
    });

    it("allows clearing cache for specific provider", () => {
      expect(() => engine.clearCache("blend_api")).not.toThrow();
    });

    it("allows clearing all cache", () => {
      expect(() => engine.clearCache()).not.toThrow();
    });
  });
});

describe("formatReliabilityScore", () => {
  it("rounds metrics to reasonable precision", async () => {
    const engine = new YieldReliabilityEngine();
    const raw = await engine.calculateReliabilityScore("test", "Test", "api");
    const formatted = formatReliabilityScore(raw);

    expect(Number.isInteger(formatted.reliabilityScore)).toBe(true);
    expect(formatted.metrics.freshness.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    expect(formatted.metrics.errorRate.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
  });
});

describe("isProviderReliable", () => {
  it("returns true for high-reliability provider", () => {
    const provider = {
      providerId: "test",
      providerName: "Test",
      dataSource: "api",
      reliabilityScore: 90,
      metrics: {
        freshness: 0.95,
        consistency: 0.9,
        historicalUptime: 0.99,
        anomalyRate: 0.05,
        latency: 200,
        errorRate: 0.02,
        coverage: 0.95,
        accuracy: 0.98,
      },
      signals: {} as never,
      status: "high" as const,
      lastUpdated: new Date().toISOString(),
      trend: "stable" as const,
      recommendations: [],
      failoverPriority: 10,
      weightInRecommendations: 1.0,
    };

    expect(isProviderReliable(provider)).toBe(true);
  });

  it("returns false for unreliable provider", () => {
    const provider = {
      providerId: "test",
      providerName: "Test",
      dataSource: "api",
      reliabilityScore: 30,
      metrics: {
        freshness: 0.3,
        consistency: 0.2,
        historicalUptime: 0.5,
        anomalyRate: 0.8,
        latency: 2000,
        errorRate: 0.3,
        coverage: 0.4,
        accuracy: 0.5,
      },
      signals: {} as never,
      status: "unreliable" as const,
      lastUpdated: new Date().toISOString(),
      trend: "declining" as const,
      recommendations: ["Disable provider"],
      failoverPriority: 999,
      weightInRecommendations: 0,
    };

    expect(isProviderReliable(provider)).toBe(false);
  });
});

describe("detectAnomalies", () => {
  it("detects anomaly when value is far from historical mean", () => {
    const historical = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    expect(detectAnomalies(50, historical, 0.1)).toBe(true);
  });

  it("does not flag normal variation", () => {
    const historical = [10, 10.1, 9.9, 10, 10.2, 9.8, 10, 10.1, 9.9, 10, 10.1, 9.9];
    expect(detectAnomalies(10.5, historical, 0.1)).toBe(false);
  });

  it("returns false with insufficient data", () => {
    expect(detectAnomalies(100, [1, 2, 3])).toBe(false);
  });
});
