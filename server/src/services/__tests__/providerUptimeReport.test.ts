import { YieldReliabilityEngine, type DataSourceReliability } from "../yieldReliabilityService";

function makeSample(
  status: DataSourceReliability["status"],
  offsetMs = 0,
): DataSourceReliability {
  return {
    providerId: "test_provider",
    providerName: "Test Provider",
    dataSource: "api",
    reliabilityScore:
      status === "high" ? 90 : status === "medium" ? 75 : status === "low" ? 55 : 0,
    metrics: {
      freshness: 0.9,
      consistency: 0.9,
      historicalUptime: 0.9,
      anomalyRate: 0.05,
      latency: 200,
      errorRate: 0.01,
      coverage: 0.95,
      accuracy: 0.95,
    },
    signals: {
      lastSuccessfulFetch: new Date().toISOString(),
      consecutiveFailures: 0,
      totalRequests: 100,
      successfulRequests: 99,
      averageResponseTime: 200,
      lastAnomaly: new Date().toISOString(),
      dataPointsLast24h: 140,
      expectedDataPoints24h: 144,
      varianceFromMean: 0.01,
      crossSourceDeviation: 0.02,
    },
    status,
    lastUpdated: new Date(Date.now() + offsetMs).toISOString(),
    trend: "stable",
    recommendations: [],
    failoverPriority: 10,
    weightInRecommendations: 1.0,
  };
}

type EngineInternals = { historicalData: Map<string, DataSourceReliability[]> };

describe("YieldReliabilityEngine.getProviderUptimeReport", () => {
  let engine: YieldReliabilityEngine;

  beforeEach(() => {
    engine = new YieldReliabilityEngine();
  });

  it("returns 100% uptime when there is no history", () => {
    const report = engine.getProviderUptimeReport("unknown", "Unknown");
    expect(report.uptimePct).toBe(100);
    expect(report.sampleCount).toBe(0);
    expect(report.outageWindowCount).toBe(0);
  });

  it("computes 100% uptime for all-healthy samples", () => {
    (engine as unknown as EngineInternals).historicalData.set("p1", [
      makeSample("high", 0),
      makeSample("high", 60_000),
      makeSample("medium", 120_000),
    ]);
    const report = engine.getProviderUptimeReport("p1", "P1");
    expect(report.uptimePct).toBe(100);
    expect(report.downtimePct).toBe(0);
    expect(report.sampleCount).toBe(3);
  });

  it("computes downtime when low/unreliable samples are present", () => {
    (engine as unknown as EngineInternals).historicalData.set("p2", [
      makeSample("high", 0),
      makeSample("unreliable", 60_000),
      makeSample("high", 120_000),
    ]);
    const report = engine.getProviderUptimeReport("p2", "P2");
    expect(report.downtimePct).toBeGreaterThan(0);
    expect(report.outageWindowCount).toBe(1);
  });

  it("caps recentOutages at 5", () => {
    const samples: DataSourceReliability[] = [];
    for (let i = 0; i < 12; i++) {
      samples.push(makeSample(i % 2 === 0 ? "high" : "unreliable", i * 60_000));
    }
    (engine as unknown as EngineInternals).historicalData.set("p3", samples);
    const report = engine.getProviderUptimeReport("p3", "P3");
    expect(report.recentOutages.length).toBeLessThanOrEqual(5);
  });

  it("marks ongoing outage with endedAt = null", () => {
    (engine as unknown as EngineInternals).historicalData.set("p4", [
      makeSample("high", 0),
      makeSample("unreliable", 60_000),
      makeSample("unreliable", 120_000),
    ]);
    const report = engine.getProviderUptimeReport("p4", "P4");
    const ongoing = report.recentOutages.find((o) => o.endedAt === null);
    expect(ongoing).toBeDefined();
  });

  it("includes providerId and providerName in report", () => {
    const report = engine.getProviderUptimeReport("xyz", "XYZ Provider");
    expect(report.providerId).toBe("xyz");
    expect(report.providerName).toBe("XYZ Provider");
  });
});
