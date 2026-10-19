import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateAndRecord,
  getGroupedDeviations,
  clearDeviationLog,
} from "../services/oracleDeviationSentinel";
import { groupOracleDeviations, severityFromEvaluation } from "../services/oracleDeviationGrouper";

const NOW = 1_750_000_000_000;
const FRESH = NOW - 1_000;

describe("oracleDeviationGrouper", () => {
  beforeEach(() => {
    clearDeviationLog();
  });

  it("groups duplicate deviations for the same asset + severity into one entry", () => {
    for (let i = 0; i < 3; i++) {
      evaluateAndRecord(
        "Blend",
        { price: 110, fetchedAt: FRESH, source: "oracle-a" },
        100,
        undefined,
        NOW + i * 1_000,
      );
    }
    const grouped = getGroupedDeviations();
    expect(grouped).toHaveLength(1);
    expect(grouped[0].primaryAsset).toBe("Blend");
    expect(grouped[0].aggregateSeverity).toBe("HIGH");
    expect(grouped[0].severityBreakdown.HIGH).toBeGreaterThanOrEqual(1);
  });

  it("keeps overlapping severities visible within the same grouped output", () => {
    // Same asset, two different severities in the correlation window.
    evaluateAndRecord("Blend", null, 100, undefined, NOW);
    evaluateAndRecord(
      "Blend",
      { price: 103, fetchedAt: FRESH, source: "oracle-a" },
      100,
      undefined,
      NOW + 1_000,
    );

    const grouped = getGroupedDeviations();
    expect(grouped).toHaveLength(1);
    expect(grouped[0].primaryAsset).toBe("Blend");
    // Both severity bands remain visible in the breakdown.
    expect(grouped[0].severityBreakdown.CRITICAL).toBeGreaterThanOrEqual(1);
    expect(grouped[0].severityBreakdown.MEDIUM).toBeGreaterThanOrEqual(1);
    // Highest severity wins as the aggregate.
    expect(grouped[0].aggregateSeverity).toBe("CRITICAL");
  });

  it("handles escalating deviations on the same asset", () => {
    evaluateAndRecord(
      "Soroswap",
      { price: 103, fetchedAt: FRESH, source: "oracle-a" },
      100,
      undefined,
      NOW,
    );
    evaluateAndRecord(
      "Soroswap",
      { price: 110, fetchedAt: NOW + 60_000 - 1_000, source: "oracle-a" },
      100,
      undefined,
      NOW + 60_000,
    );

    const grouped = getGroupedDeviations();
    expect(grouped).toHaveLength(1);
    expect(grouped[0].primaryAsset).toBe("Soroswap");
    // Both escalation severities are visible in the breakdown.
    expect(grouped[0].severityBreakdown.HIGH).toBeGreaterThanOrEqual(1);
    expect(grouped[0].severityBreakdown.MEDIUM).toBeGreaterThanOrEqual(1);
    // Aggregate reflects the highest severity reached.
    expect(grouped[0].aggregateSeverity).toBe("HIGH");
  });

  it("does not group deviations across different assets", () => {
    evaluateAndRecord("Blend", { price: 110, fetchedAt: FRESH, source: "oracle-a" }, 100, undefined, NOW);
    evaluateAndRecord("Soroswap", { price: 110, fetchedAt: FRESH, source: "oracle-a" }, 100, undefined, NOW + 1_000);

    const grouped = getGroupedDeviations();
    expect(grouped).toHaveLength(2);
    const assets = grouped.map((g) => g.primaryAsset).sort();
    expect(assets).toEqual(["Blend", "Soroswap"]);
  });

  it("returns an empty array when no events have been recorded", () => {
    expect(getGroupedDeviations()).toEqual([]);
  });

  it("maps oracle state + decision to severity bands", () => {
    expect(severityFromEvaluation("MISSING", "BLOCK")).toBe("CRITICAL");
    expect(severityFromEvaluation("STALE", "BLOCK")).toBe("CRITICAL");
    expect(severityFromEvaluation("DEVIATED", "BLOCK")).toBe("HIGH");
    expect(severityFromEvaluation("VALID", "DOWNGRADE")).toBe("MEDIUM");
    expect(severityFromEvaluation("VALID", "ALLOW")).toBe("LOW");
    expect(severityFromEvaluation("FRESH", "ALLOW")).toBe("LOW");
  });

  it("accepts an explicit batch via groupOracleDeviations", () => {
    const batch = [
      {
        id: "d1", assetId: "Blend", reading: { price: 110, fetchedAt: FRESH, source: "x" },
        referencePrice: 100, timestamp: NOW,
        evaluation: { state: "DEVIATED" as const, decision: "BLOCK" as const, deviationPct: 10, ageMs: 1000, reasons: ["over max"], recordedAt: NOW },
      },
      {
        id: "d2", assetId: "Blend", reading: { price: 110, fetchedAt: FRESH, source: "x" },
        referencePrice: 100, timestamp: NOW + 1_000,
        evaluation: { state: "DEVIATED" as const, decision: "BLOCK" as const, deviationPct: 10, ageMs: 1000, reasons: ["over max"], recordedAt: NOW + 1_000 },
      },
    ];
    const grouped = groupOracleDeviations(batch);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].primaryAsset).toBe("Blend");
  });
});