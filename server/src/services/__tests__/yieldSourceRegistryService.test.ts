import {
  classifySourceHealth,
  summarizeSourceHealth,
  toSourceHealth,
  getSourceHealthRegistry,
  SOURCE_HEALTH_THRESHOLDS,
  type SourceHealthInput,
  type SourceHealthSummary,
} from "../yieldSourceRegistryService";
import type { DataSourceReliability } from "../yieldReliabilityService";

const baseInput: SourceHealthInput = {
  reliabilityStatus: "high",
  reliabilityScore: 92,
  consecutiveFailures: 0,
  errorRate: 0.01,
  latencyMs: 200,
  freshness: 0.95,
  ageSeconds: 120,
};

describe("classifySourceHealth", () => {
  it("marks a fresh, low-error source as healthy with no failure reason", () => {
    const result = classifySourceHealth(baseInput);
    expect(result.status).toBe("healthy");
    expect(result.failureReason).toBeNull();
  });

  it("marks a source unavailable after consecutive failures", () => {
    const result = classifySourceHealth({
      ...baseInput,
      consecutiveFailures: SOURCE_HEALTH_THRESHOLDS.unavailableConsecutiveFailures,
    });
    expect(result.status).toBe("unavailable");
    expect(result.failureReason).toMatch(/consecutive fetch failures/);
  });

  it("marks an 'unreliable' source unavailable", () => {
    const result = classifySourceHealth({
      ...baseInput,
      reliabilityStatus: "unreliable",
      reliabilityScore: 0,
    });
    expect(result.status).toBe("unavailable");
  });

  it("marks an old source stale even when connectivity looks fine", () => {
    const result = classifySourceHealth({
      ...baseInput,
      ageSeconds: SOURCE_HEALTH_THRESHOLDS.staleAgeSeconds + 60,
    });
    expect(result.status).toBe("stale");
    expect(result.failureReason).toMatch(/No fresh data/);
  });

  it("marks a high-latency source degraded", () => {
    const result = classifySourceHealth({
      ...baseInput,
      latencyMs: SOURCE_HEALTH_THRESHOLDS.degradedMaxLatencyMs + 100,
    });
    expect(result.status).toBe("degraded");
    expect(result.failureReason).toMatch(/Elevated latency/);
  });

  it("marks an elevated-error source degraded", () => {
    const result = classifySourceHealth({
      ...baseInput,
      errorRate: SOURCE_HEALTH_THRESHOLDS.degradedMaxErrorRate + 0.02,
    });
    expect(result.status).toBe("degraded");
    expect(result.failureReason).toMatch(/Elevated error rate/);
  });

  it("prioritizes unavailable over stale", () => {
    const result = classifySourceHealth({
      ...baseInput,
      reliabilityStatus: "unreliable",
      ageSeconds: SOURCE_HEALTH_THRESHOLDS.staleAgeSeconds + 60,
    });
    expect(result.status).toBe("unavailable");
  });
});

describe("toSourceHealth", () => {
  const reliability: DataSourceReliability = {
    providerId: "blend_api",
    providerName: "Blend Protocol",
    dataSource: "api",
    reliabilityScore: 88.6,
    status: "high",
    lastUpdated: new Date().toISOString(),
    trend: "stable",
    recommendations: [],
    failoverPriority: 5,
    weightInRecommendations: 1,
    metrics: {
      freshness: 0.9,
      consistency: 0.9,
      historicalUptime: 0.985,
      anomalyRate: 0.02,
      latency: 250,
      errorRate: 0.015,
      coverage: 0.98,
      accuracy: 0.95,
    },
    signals: {
      lastSuccessfulFetch: new Date(Date.now() - 60_000).toISOString(),
      consecutiveFailures: 0,
      totalRequests: 1000,
      successfulRequests: 985,
      averageResponseTime: 250,
      lastAnomaly: new Date().toISOString(),
      dataPointsLast24h: 142,
      expectedDataPoints24h: 144,
      varianceFromMean: 0.02,
      crossSourceDeviation: 0.05,
    },
  };

  it("produces the documented response shape", () => {
    const summary = toSourceHealth(reliability);
    expect(summary).toMatchObject({
      providerId: "blend_api",
      providerName: "Blend Protocol",
      dataSource: "api",
    });
    expect(typeof summary.status).toBe("string");
    expect(typeof summary.uptimePct).toBe("number");
    expect(typeof summary.latencyMs).toBe("number");
    expect(typeof summary.latestFetch).toBe("string");
    expect(summary.reliabilityScore).toBe(89); // rounded
    expect(summary.uptimePct).toBeCloseTo(98.5, 1);
    expect(summary.status).toBe("healthy");
  });

  it("flags stale when the last fetch is far in the past", () => {
    const stale = toSourceHealth({
      ...reliability,
      signals: {
        ...reliability.signals,
        lastSuccessfulFetch: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    });
    expect(stale.status).toBe("stale");
    expect(stale.ageSeconds).toBeGreaterThan(
      SOURCE_HEALTH_THRESHOLDS.staleAgeSeconds,
    );
  });
});

describe("summarizeSourceHealth", () => {
  it("counts every status bucket", () => {
    const sources = [
      { status: "healthy" },
      { status: "healthy" },
      { status: "degraded" },
      { status: "unavailable" },
    ] as SourceHealthSummary[];
    expect(summarizeSourceHealth(sources)).toEqual({
      healthy: 2,
      degraded: 1,
      stale: 0,
      unavailable: 1,
    });
  });
});

describe("getSourceHealthRegistry", () => {
  it("returns a registry covering all registered sources", async () => {
    const registry = await getSourceHealthRegistry();
    expect(registry.totalSources).toBe(registry.sources.length);
    expect(registry.totalSources).toBeGreaterThan(0);
    expect(typeof registry.generatedAt).toBe("string");

    const summed =
      registry.counts.healthy +
      registry.counts.degraded +
      registry.counts.stale +
      registry.counts.unavailable;
    expect(summed).toBe(registry.totalSources);

    for (const source of registry.sources) {
      expect(typeof source.providerId).toBe("string");
      expect(["healthy", "degraded", "stale", "unavailable"]).toContain(
        source.status,
      );
    }
  });
});
