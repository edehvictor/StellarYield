import {
  computeFreshnessStatus,
  DEFAULT_FRESHNESS_THRESHOLDS,
} from "../services/sourceHealthService";

const NOW = new Date("2026-08-31T12:00:00.000Z");

describe("source health graded freshness states", () => {
  it("classifies data across fresh, aging, stale, and expired thresholds", () => {
    expect(computeFreshnessStatus(new Date(NOW.getTime() - 60_000).toISOString(), NOW).status)
      .toBe("fresh");
    expect(computeFreshnessStatus(new Date(NOW.getTime() - 30 * 60_000).toISOString(), NOW).status)
      .toBe("aging");
    expect(computeFreshnessStatus(new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString(), NOW).status)
      .toBe("stale");
    expect(computeFreshnessStatus(new Date(NOW.getTime() - 48 * 60 * 60_000).toISOString(), NOW).status)
      .toBe("expired");
  });

  it("adds UI-ready severity to each freshness result", () => {
    expect(computeFreshnessStatus(new Date(NOW.getTime() - 60_000).toISOString(), NOW).severity)
      .toBe("ok");
    expect(computeFreshnessStatus(new Date(NOW.getTime() - DEFAULT_FRESHNESS_THRESHOLDS.agingWindowMs).toISOString(), NOW).severity)
      .toBe("warning");
    expect(computeFreshnessStatus(new Date(NOW.getTime() - 48 * 60 * 60_000).toISOString(), NOW).severity)
      .toBe("critical");
    expect(computeFreshnessStatus(undefined, NOW).severity).toBe("unknown");
  });
});