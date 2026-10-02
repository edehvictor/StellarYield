import { describe, expect, it } from "vitest";
import {
  getYieldSourceFreshness,
  YIELD_SOURCE_STALE_THRESHOLD_MS,
} from "../yieldSourceFreshness";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");

describe("getYieldSourceFreshness", () => {
  it("keeps recent source data fresh through the configured threshold", () => {
    const fetchedAt = new Date(NOW - YIELD_SOURCE_STALE_THRESHOLD_MS).toISOString();

    expect(getYieldSourceFreshness({ fetchedAt }, NOW)).toEqual({
      status: "fresh",
      ageMinutes: 5,
    });
  });

  it("marks old timestamps and an explicit server stale signal as stale", () => {
    const fetchedAt = new Date(NOW - YIELD_SOURCE_STALE_THRESHOLD_MS - 1).toISOString();

    expect(getYieldSourceFreshness({ fetchedAt }, NOW).status).toBe("stale");
    expect(
      getYieldSourceFreshness(
        { fetchedAt: new Date(NOW).toISOString(), isStale: true },
        NOW,
      ).status,
    ).toBe("stale");
  });

  it("reports missing, invalid, and future timestamps as unknown", () => {
    expect(getYieldSourceFreshness({}, NOW)).toEqual({ status: "unknown" });
    expect(getYieldSourceFreshness({ fetchedAt: "invalid" }, NOW)).toEqual({
      status: "unknown",
    });
    expect(
      getYieldSourceFreshness(
        { fetchedAt: new Date(NOW + 60_000).toISOString() },
        NOW,
      ),
    ).toEqual({ status: "unknown" });
  });
});
