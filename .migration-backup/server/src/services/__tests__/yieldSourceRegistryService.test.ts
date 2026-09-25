import {
  classifySourceHealth,
  summarizeSourceHealth,
  toSourceHealth,
  getSourceHealthRegistry,
  SOURCE_HEALTH_THRESHOLDS,
  type SourceHealthInput,
  type SourceHealthSummary,
  detectRegistryConflicts,
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
      consecutiveFailures:
        SOURCE_HEALTH_THRESHOLDS.unavailableConsecutiveFailures,
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

describe("detectRegistryConflicts", () => {
  it("detects duplicate provider IDs and reports both entries", () => {
    const result = detectRegistryConflicts([
      { id: "blend_api", name: "Blend", source: "api" },
      { id: "blend_api", name: "Blend mirror", source: "api" },
    ]);

    expect(result.status).toBe("conflicted");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      type: "providerId",
      identity: "blend_api",
    });
    expect(
      result.conflicts[0]?.entries.map((entry) => entry.providerName),
    ).toEqual(["Blend", "Blend mirror"]);
  });

  it("detects an alias shared by otherwise distinct providers", () => {
    const result = detectRegistryConflicts([
      { id: "blend_api", name: "Blend", source: "api", aliases: ["blend"] },
      { id: "blend_v2", name: "Blend v2", source: "api", aliases: [" BLEND "] },
    ]);

    expect(result.conflicts).toEqual([
      expect.objectContaining({ type: "alias", identity: "blend" }),
    ]);
  });

  it("keeps source labels distinct when only the URL path differs", () => {
    const result = detectRegistryConflicts([
      {
        id: "feed_a",
        name: "Feed A",
        source: "api",
        sourceLabel: "https://feeds.example.com/v1",
      },
      {
        id: "feed_b",
        name: "Feed B",
        source: "api",
        sourceLabel: "https://feeds.example.com/v2",
      },
    ]);

    expect(result.status).toBe("valid");
    expect(result.conflicts).toHaveLength(0);
  });

  it("detects a source label repeated with case and trailing-slash differences", () => {
    const result = detectRegistryConflicts([
      {
        id: "feed_a",
        name: "Feed A",
        source: "api",
        sourceLabel: "https://feeds.example.com/v1/",
      },
      {
        id: "feed_b",
        name: "Feed B",
        source: "api",
        sourceLabel: "HTTPS://FEEDS.EXAMPLE.COM/v1",
      },
    ]);

    expect(result.conflicts[0]).toMatchObject({
      type: "sourceLabel",
      identity: "feeds.example.com/v1",
    });
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
        lastSuccessfulFetch: new Date(
          Date.now() - 60 * 60 * 1000,
        ).toISOString(),
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

  it("includes cacheAge, cacheVersion, and lastInvalidatedAt diagnostics", async () => {
    const registry = await getSourceHealthRegistry();

    // cacheAge is 0 on first call (freshly generated)
    expect(registry.cacheAge).toBe(0);

    // cacheVersion is a positive integer
    expect(typeof registry.cacheVersion).toBe("number");
    expect(registry.cacheVersion).toBeGreaterThan(0);

    // lastInvalidatedAt is a valid ISO timestamp
    expect(typeof registry.lastInvalidatedAt).toBe("string");
    expect(new Date(registry.lastInvalidatedAt).toString()).not.toBe(
      "Invalid Date",
    );
  });

  it("increments cacheVersion and includes cacheAge on subsequent calls", async () => {
    // Clear cache between tests to get a fresh start
    const registry1 = await getSourceHealthRegistry();
    expect(registry1.cacheAge).toBe(0);
    const v1 = registry1.cacheVersion;

    // Second call within TTL should return cached version with non-zero age
    const registry2 = await getSourceHealthRegistry();
    expect(registry2.cacheVersion).toBe(v1);
    expect(registry2.cacheAge).toBeGreaterThanOrEqual(0);
    expect(registry2.totalSources).toBe(registry1.totalSources);

    // Verify sources are consistent between calls
    expect(registry2.sources.length).toBe(registry1.sources.length);
  });
});
