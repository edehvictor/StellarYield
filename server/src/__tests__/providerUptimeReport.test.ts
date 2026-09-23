import {
  buildProviderUptimeReportExport,
  type ProviderUptimeSample,
} from "../services/providerUptimeReportService";

describe("provider uptime export report", () => {
  const base = (overrides: Partial<ProviderUptimeSample> = {}): ProviderUptimeSample => ({
    providerId: "p1",
    providerName: "Provider One",
    sourceGroup: "api",
    status: "high",
    lastUpdated: "2024-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("includes uptime, downtime, recovery, and alert history in the export", () => {
    const samples: ProviderUptimeSample[] = [
      base({ status: "high", lastUpdated: "2024-01-01T00:00:00.000Z" }),
      base({ status: "low", lastUpdated: "2024-01-01T00:30:00.000Z" }),
      base({ status: "high", lastUpdated: "2024-01-01T01:00:00.000Z" }),
    ];

    const report = buildProviderUptimeReportExport(samples, {
      startDate: "2024-01-01T00:00:00.000Z",
      endDate: "2024-01-01T02:00:00.000Z",
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].uptimeMinutes).toBeGreaterThan(0);
    expect(report.rows[0].downtimeMinutes).toBeGreaterThan(0);
    expect(report.rows[0].alertWindowCount).toBe(1);
    expect(report.rows[0].recoveryIntervalCount).toBeGreaterThanOrEqual(1);
    expect(report.rows[0].alertWindows[0].startedAt).toBe("2024-01-01T00:30:00.000Z");
  });

  it("handles partial periods correctly when the period starts mid-outage", () => {
    const samples: ProviderUptimeSample[] = [
      base({ status: "low", lastUpdated: "2024-01-01T00:15:00.000Z" }),
      base({ status: "high", lastUpdated: "2024-01-01T00:45:00.000Z" }),
    ];

    const report = buildProviderUptimeReportExport(samples, {
      startDate: "2024-01-01T00:00:00.000Z",
      endDate: "2024-01-01T01:00:00.000Z",
    });

    expect(report.rows[0].downtimeMinutes).toBeGreaterThan(0);
    expect(report.rows[0].uptimeMinutes).toBeGreaterThan(0);
    expect(report.rows[0].periodStart).toBe("2024-01-01T00:00:00.000Z");
    expect(report.rows[0].periodEnd).toBe("2024-01-01T01:00:00.000Z");
  });

  it("merges overlapping outage windows and recovery intervals", () => {
    const samples: ProviderUptimeSample[] = [
      base({ status: "high", lastUpdated: "2024-01-01T00:00:00.000Z" }),
      base({ status: "low", lastUpdated: "2024-01-01T00:20:00.000Z" }),
      base({ status: "unreliable", lastUpdated: "2024-01-01T00:40:00.000Z" }),
      base({ status: "high", lastUpdated: "2024-01-01T01:00:00.000Z" }),
    ];

    const report = buildProviderUptimeReportExport(samples, {
      startDate: "2024-01-01T00:00:00.000Z",
      endDate: "2024-01-01T01:30:00.000Z",
    });

    expect(report.rows[0].alertWindowCount).toBe(1);
    expect(report.rows[0].alertWindows[0].status).toBe("low");
    expect(report.rows[0].recoveryIntervals.length).toBeGreaterThanOrEqual(1);
  });
});
