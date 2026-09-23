import {
  computeFreshnessStatus,
  DEFAULT_FRESHNESS_THRESHOLDS,
} from "../services/sourceHealthService";

const NOW = new Date("2026-06-30T12:00:00.000Z");

describe("computeFreshnessStatus", () => {
  it("classifies a recently-fetched source as fresh", () => {
    const fetchedAt = new Date(NOW.getTime() - 60_000).toISOString(); // 1 min ago
    const result = computeFreshnessStatus(fetchedAt, NOW);

    expect(result.status).toBe("fresh");
    expect(result.ageSeconds).toBe(60);
    expect(result.fetchedAt).toBe(fetchedAt);
  });

  it("classifies a source at exactly the fresh window boundary as fresh", () => {
    const fetchedAt = new Date(
      NOW.getTime() - DEFAULT_FRESHNESS_THRESHOLDS.freshWindowMs,
    ).toISOString();
    const result = computeFreshnessStatus(fetchedAt, NOW);

    expect(result.status).toBe("fresh");
  });

  it("classifies a source just past the fresh window as stale", () => {
    const fetchedAt = new Date(
      NOW.getTime() - DEFAULT_FRESHNESS_THRESHOLDS.freshWindowMs - 1_000,
    ).toISOString();
    const result = computeFreshnessStatus(fetchedAt, NOW);

    expect(result.status).toBe("stale");
  });

  it("classifies a source fetched hours ago as stale, not unknown", () => {
    const fetchedAt = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    const result = computeFreshnessStatus(fetchedAt, NOW);

    expect(result.status).toBe("stale");
    expect(result.ageSeconds).toBe(3 * 60 * 60);
  });

  it("classifies a missing fetchedAt as unknown", () => {
    const result = computeFreshnessStatus(undefined, NOW);

    expect(result.status).toBe("unknown");
    expect(result.ageSeconds).toBeNull();
    expect(result.fetchedAt).toBeNull();
  });

  it("classifies a null fetchedAt as unknown", () => {
    const result = computeFreshnessStatus(null, NOW);
    expect(result.status).toBe("unknown");
  });

  it("classifies an empty string fetchedAt as unknown", () => {
    const result = computeFreshnessStatus("", NOW);
    expect(result.status).toBe("unknown");
  });

  it("classifies an unparseable timestamp as unknown rather than throwing", () => {
    expect(() => computeFreshnessStatus("not-a-date", NOW)).not.toThrow();
    const result = computeFreshnessStatus("not-a-date", NOW);
    expect(result.status).toBe("unknown");
    expect(result.ageSeconds).toBeNull();
  });

  it("never returns a negative ageSeconds for a fetchedAt slightly in the future (clock skew)", () => {
    const fetchedAt = new Date(NOW.getTime() + 5_000).toISOString();
    const result = computeFreshnessStatus(fetchedAt, NOW);
    expect(result.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it("respects custom thresholds", () => {
    const fetchedAt = new Date(NOW.getTime() - 30_000).toISOString(); // 30s ago
    const strict = computeFreshnessStatus(fetchedAt, NOW, { freshWindowMs: 10_000 });
    const lenient = computeFreshnessStatus(fetchedAt, NOW, { freshWindowMs: 60_000 });

    expect(strict.status).toBe("stale");
    expect(lenient.status).toBe("fresh");
  });

  it("defaults `now` to the current time when omitted", () => {
    const fetchedAt = new Date().toISOString();
    const result = computeFreshnessStatus(fetchedAt);
    expect(result.status).toBe("fresh");
  });

  it("marks status as exhausted when retry budget is exhausted", () => {
    const fetchedAt = new Date(NOW.getTime() - 60_000).toISOString();
    const result = computeFreshnessStatus(
      fetchedAt,
      NOW,
      DEFAULT_FRESHNESS_THRESHOLDS,
      undefined,
      true,
    );
    expect(result.status).toBe("exhausted");
  });
});