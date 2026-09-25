import { describe, it, expect } from "vitest";
import {
  getIndexerStatusDisplay,
  formatLag,
  formatDuplicatesSuppressed,
  isIndexerDegraded,
  type IndexerStatus,
} from "./indexerStatus";

const status = (overrides: Partial<IndexerStatus> = {}): IndexerStatus => ({
  status: "healthy",
  reason: null,
  indexedLedger: 1000,
  horizonLedger: 1002,
  lagLedgers: 2,
  lastIndexedAt: null,
  heartbeatAgeSeconds: null,
  recentErrors: [],
  generatedAt: new Date().toISOString(),
  ...overrides,
});

describe("getIndexerStatusDisplay", () => {
  it("maps healthy to a non-attention success badge", () => {
    const display = getIndexerStatusDisplay("healthy");
    expect(display.variant).toBe("success");
    expect(display.needsAttention).toBe(false);
  });

  it("maps degraded to an attention-worthy warning badge", () => {
    const display = getIndexerStatusDisplay("degraded");
    expect(display.variant).toBe("warning");
    expect(display.needsAttention).toBe(true);
  });

  it("maps unavailable to a danger badge", () => {
    expect(getIndexerStatusDisplay("unavailable").variant).toBe("danger");
  });

  it("falls back to neutral for unexpected values", () => {
    expect(getIndexerStatusDisplay("???").label).toBe("Unknown");
  });
});

describe("formatLag", () => {
  it("renders in sync, singular, and plural correctly", () => {
    expect(formatLag(0)).toBe("in sync");
    expect(formatLag(1)).toBe("1 ledger behind");
    expect(formatLag(42)).toBe("42 ledgers behind");
  });
  it("renders unknown for null lag", () => {
    expect(formatLag(null)).toBe("unknown");
  });
});

describe("isIndexerDegraded", () => {
  it("is false only for healthy", () => {
    expect(isIndexerDegraded(status({ status: "healthy" }))).toBe(false);
    expect(isIndexerDegraded(status({ status: "degraded" }))).toBe(true);
    expect(isIndexerDegraded(status({ status: "unavailable" }))).toBe(true);
  });
});

describe("formatDuplicatesSuppressed", () => {
  it("pluralizes and floors the count", () => {
    expect(formatDuplicatesSuppressed(0)).toBe("0 duplicates suppressed");
    expect(formatDuplicatesSuppressed(1)).toBe("1 duplicate suppressed");
    expect(formatDuplicatesSuppressed(42.9)).toBe("42 duplicates suppressed");
  });

  it("returns null for missing or unusable counts so the panel omits the metric", () => {
    expect(formatDuplicatesSuppressed(undefined)).toBeNull();
    expect(formatDuplicatesSuppressed(null)).toBeNull();
    expect(formatDuplicatesSuppressed(Number.NaN)).toBeNull();
    expect(formatDuplicatesSuppressed(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatDuplicatesSuppressed(-1)).toBeNull();
  });
});

describe("IndexerStatus duplicatesSkipped (#1361)", () => {
  it("is optional so older server responses remain valid", () => {
    const without = status();
    expect(without.duplicatesSkipped).toBeUndefined();
    expect(formatDuplicatesSuppressed(without.duplicatesSkipped)).toBeNull();

    const withCount = status({ duplicatesSkipped: 7 });
    expect(formatDuplicatesSuppressed(withCount.duplicatesSkipped)).toBe(
      "7 duplicates suppressed",
    );
  });
});
