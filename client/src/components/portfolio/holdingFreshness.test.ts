import { describe, expect, it } from "vitest";
import {
  computeHoldingFreshness,
  formatFreshnessAge,
  FRESH_WINDOW_MS,
} from "./holdingFreshness";

const NOW = new Date("2026-06-30T12:00:00.000Z");

describe("computeHoldingFreshness", () => {
  it("classifies a recently-fetched holding as fresh", () => {
    const fetchedAt = new Date(NOW.getTime() - 30_000).toISOString();
    const result = computeHoldingFreshness(fetchedAt, NOW);

    expect(result.status).toBe("fresh");
    expect(result.ageSeconds).toBe(30);
  });

  it("classifies a holding right at the fresh window boundary as fresh", () => {
    const fetchedAt = new Date(NOW.getTime() - FRESH_WINDOW_MS).toISOString();
    const result = computeHoldingFreshness(fetchedAt, NOW);
    expect(result.status).toBe("fresh");
  });

  it("classifies a holding just past the fresh window as stale", () => {
    const fetchedAt = new Date(NOW.getTime() - FRESH_WINDOW_MS - 1_000).toISOString();
    const result = computeHoldingFreshness(fetchedAt, NOW);
    expect(result.status).toBe("stale");
  });

  it("classifies a holding fetched an hour ago as stale", () => {
    const fetchedAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const result = computeHoldingFreshness(fetchedAt, NOW);
    expect(result.status).toBe("stale");
  });

  it("classifies a missing fetchedAt as unknown", () => {
    expect(computeHoldingFreshness(undefined, NOW).status).toBe("unknown");
    expect(computeHoldingFreshness(null, NOW).status).toBe("unknown");
    expect(computeHoldingFreshness("", NOW).status).toBe("unknown");
  });

  it("classifies an unparseable timestamp as unknown instead of throwing", () => {
    expect(() => computeHoldingFreshness("not-a-date", NOW)).not.toThrow();
    expect(computeHoldingFreshness("not-a-date", NOW).status).toBe("unknown");
  });

  it("returns null ageSeconds for unknown status", () => {
    expect(computeHoldingFreshness(undefined, NOW).ageSeconds).toBeNull();
  });
});

describe("formatFreshnessAge", () => {
  it("formats sub-minute ages in seconds", () => {
    expect(formatFreshnessAge(45)).toBe("45s ago");
  });

  it("formats sub-hour ages in minutes", () => {
    expect(formatFreshnessAge(150)).toBe("3m ago");
  });

  it("formats multi-hour ages in hours", () => {
    expect(formatFreshnessAge(2 * 60 * 60)).toBe("2h ago");
  });

  it("returns null for a null age", () => {
    expect(formatFreshnessAge(null)).toBeNull();
  });

  it("returns null for an undefined age", () => {
    expect(formatFreshnessAge(undefined)).toBeNull();
  });
});