import { describe, it, expect } from "vitest";
import type { ValuationFreshness } from "../../../shared/types/dailyMovement";
import {
  DailyMovementError,
  describeDailyMovementFailure,
  describeFreshnessNotice,
} from "./dailyMovementErrors";

const HOUR_MS = 60 * 60 * 1000;

const freshness = (
  overrides: Partial<ValuationFreshness> = {},
): ValuationFreshness => ({
  evaluatedAt: new Date().toISOString(),
  snapshotValuedAt: new Date(Date.now() - 48 * HOUR_MS).toISOString(),
  ageMs: 48 * HOUR_MS,
  maxAgeMs: 36 * HOUR_MS,
  isStale: true,
  ...overrides,
});

describe("describeDailyMovementFailure", () => {
  it("maps STALE_VALUATION_SNAPSHOT to stable retryable copy when the body has no message", () => {
    const failure = describeDailyMovementFailure(409, {
      error: "STALE_VALUATION_SNAPSHOT",
    });
    expect(failure.code).toBe("STALE_VALUATION_SNAPSHOT");
    expect(failure.status).toBe(409);
    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain("snapshot refresh");
  });

  it("prefers the server-provided message for STALE_VALUATION_SNAPSHOT", () => {
    const failure = describeDailyMovementFailure(409, {
      error: "STALE_VALUATION_SNAPSHOT",
      message: "Portfolio valuation snapshot is stale (410400s old).",
    });
    expect(failure.code).toBe("STALE_VALUATION_SNAPSHOT");
    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain("stale");
  });

  it("keeps the server message for SNAPSHOT_NOT_FOUND", () => {
    const failure = describeDailyMovementFailure(404, {
      error: "SNAPSHOT_NOT_FOUND",
      message: "No portfolio snapshot found for GAAA… on 2026-01-01.",
    });
    expect(failure.code).toBe("SNAPSHOT_NOT_FOUND");
    expect(failure.message).toContain("No portfolio snapshot found");
    expect(failure.retryable).toBe(false);
  });

  it("falls back to status-based copy when the body is not JSON", () => {
    const failure = describeDailyMovementFailure(500, null);
    expect(failure.code).toBe("DAILY_MOVEMENT_FAILED");
    expect(failure.message).toBe("Failed to fetch daily movement.");
    expect(failure.retryable).toBe(true);
  });

  it("never surfaces unknown raw codes without a message fallback", () => {
    const failure = describeDailyMovementFailure(418, {
      error: "TEAPOT",
      message: "I'm a teapot",
    });
    expect(failure.code).toBe("TEAPOT");
    expect(failure.message).toBe("I'm a teapot");
    expect(failure.retryable).toBe(false);
  });

  it("handles network failures (status 0)", () => {
    const failure = describeDailyMovementFailure(0, undefined);
    expect(failure.code).toBe("NETWORK_ERROR");
    expect(failure.retryable).toBe(true);
  });
});

describe("DailyMovementError", () => {
  it("carries the failure code/status alongside the message", () => {
    const err = new DailyMovementError(
      describeDailyMovementFailure(409, {
        error: "STALE_VALUATION_SNAPSHOT",
        message: "stale",
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DailyMovementError");
    expect(err.code).toBe("STALE_VALUATION_SNAPSHOT");
    expect(err.status).toBe(409);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("stale");
  });
});

describe("describeFreshnessNotice", () => {
  it("returns null when freshness is absent or fresh", () => {
    expect(describeFreshnessNotice(undefined)).toBeNull();
    expect(
      describeFreshnessNotice(freshness({ isStale: false, ageMs: HOUR_MS })),
    ).toBeNull();
  });

  it("returns null for fresh-but-present annotations", () => {
    expect(
      describeFreshnessNotice(
        freshness({ isStale: false, ageMs: HOUR_MS, snapshotValuedAt: new Date().toISOString() }),
      ),
    ).toBeNull();
  });

  it("explains a missing snapshot", () => {
    const notice = describeFreshnessNotice(
      freshness({ snapshotValuedAt: null, ageMs: null }),
    );
    expect(notice).toContain("No valuation snapshot available");
  });

  it("formats age and limit for a stale snapshot", () => {
    const notice = describeFreshnessNotice(freshness());
    expect(notice).toContain("48h ago");
    expect(notice).toContain("limit 36h");
  });
});
