import { describe, expect, it } from "vitest";
import {
  formatLastKnownUpdate,
  getSharePriceFreshnessDisplay,
  type SharePriceFreshness,
} from "./sharePriceFreshness";

function makeFreshness(
  overrides: Partial<SharePriceFreshness> = {},
): SharePriceFreshness {
  return {
    vaultId: "primary-yield-vault",
    status: "current",
    isDelayed: false,
    sharePriceUpdatedAt: "2026-09-25T06:00:00.000Z",
    eventCheckpointAt: "2026-09-25T07:00:00.000Z",
    delayMs: 3_600_000,
    maxDelayMs: 129_600_000,
    message: null,
    evaluatedAt: "2026-09-25T12:00:00.000Z",
    ...overrides,
  };
}

describe("formatLastKnownUpdate", () => {
  it("formats an ISO timestamp as UTC", () => {
    expect(formatLastKnownUpdate("2026-09-25T11:04:05.000Z")).toBe(
      "2026-09-25 11:04:05 UTC",
    );
  });

  it("returns null for missing or malformed values", () => {
    expect(formatLastKnownUpdate(null)).toBeNull();
    expect(formatLastKnownUpdate(undefined)).toBeNull();
    expect(formatLastKnownUpdate("not-a-date")).toBeNull();
  });
});

describe("getSharePriceFreshnessDisplay", () => {
  it("stays quiet (null) when data is current", () => {
    expect(getSharePriceFreshnessDisplay(makeFreshness())).toBeNull();
  });

  it("stays quiet when there is no payload", () => {
    expect(getSharePriceFreshnessDisplay(null)).toBeNull();
    expect(getSharePriceFreshnessDisplay(undefined)).toBeNull();
  });

  it("returns a warning with the last known update when delayed", () => {
    const display = getSharePriceFreshnessDisplay(
      makeFreshness({
        status: "delayed",
        isDelayed: true,
        sharePriceUpdatedAt: "2026-09-23T11:04:05.000Z",
        message: "Share price data is 49.0h behind the latest indexed event.",
      }),
    );

    expect(display).not.toBeNull();
    expect(display?.variant).toBe("warning");
    expect(display?.label).toBe("Share price delayed");
    expect(display?.message).toContain("behind the latest indexed event");
    expect(display?.lastUpdatedAt).toBe("2026-09-23 11:04:05 UTC");
  });

  it("returns a danger warning when the snapshot is missing", () => {
    const display = getSharePriceFreshnessDisplay(
      makeFreshness({
        status: "missing",
        isDelayed: true,
        sharePriceUpdatedAt: null,
        message: "No share price snapshot recorded.",
      }),
    );

    expect(display).not.toBeNull();
    expect(display?.variant).toBe("danger");
    expect(display?.label).toBe("Share price data unavailable");
    expect(display?.lastUpdatedAt).toBeNull();
  });

  it("returns a danger warning when the checkpoint is missing but keeps the last update", () => {
    const display = getSharePriceFreshnessDisplay(
      makeFreshness({
        status: "missing",
        isDelayed: true,
        sharePriceUpdatedAt: "2026-09-24T08:30:00.000Z",
        eventCheckpointAt: null,
        message: "Indexer checkpoint unavailable.",
      }),
    );

    expect(display?.variant).toBe("danger");
    expect(display?.lastUpdatedAt).toBe("2026-09-24 08:30:00 UTC");
  });
});
