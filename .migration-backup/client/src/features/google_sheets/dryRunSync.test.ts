import { describe, it, expect } from "vitest";
import { buildRowKey, rowKeyToString, computeDryRunSyncPlan } from "./dryRunSync";
import type { DailyYieldMetric } from "./types";
import type { ExistingSheetRow } from "./dryRunSync";

function metric(overrides: Partial<DailyYieldMetric> = {}): DailyYieldMetric {
  return {
    date: "2026-05-04",
    vaultName: "USDC Vault",
    depositAmount: 1000n,
    currentValue: 1050n,
    dailyYield: 5n,
    apy: 12.34,
    walletAddress: "GALICE",
    asset: "USDC",
    ...overrides,
  };
}

function existingRow(overrides: Partial<ExistingSheetRow> = {}): ExistingSheetRow {
  return {
    walletAddress: "GALICE",
    vaultName: "USDC Vault",
    asset: "USDC",
    timestamp: "2026-05-04",
    depositAmount: "1000",
    currentValue: "1050",
    dailyYield: "5",
    apy: "12.34",
    ...overrides,
  };
}

describe("buildRowKey / rowKeyToString", () => {
  it("builds a key from wallet, vault, asset, and date", () => {
    const key = buildRowKey(metric());
    expect(key).toEqual({
      walletAddress: "GALICE",
      vaultName: "USDC Vault",
      asset: "USDC",
      timestamp: "2026-05-04",
    });
  });

  it("falls back to placeholders when wallet/asset are absent", () => {
    const key = buildRowKey(metric({ walletAddress: undefined, asset: undefined }));
    expect(key.walletAddress).toBe("unknown-wallet");
    expect(key.asset).toBe("unknown-asset");
  });

  it("produces distinct strings for different keys", () => {
    const a = rowKeyToString(buildRowKey(metric()));
    const b = rowKeyToString(buildRowKey(metric({ asset: "XLM" })));
    expect(a).not.toBe(b);
  });
});

describe("computeDryRunSyncPlan", () => {
  it("marks a metric with no existing row as added", () => {
    const summary = computeDryRunSyncPlan([metric()], []);
    expect(summary.added).toHaveLength(1);
    expect(summary.updated).toHaveLength(0);
    expect(summary.skipped).toHaveLength(0);
    expect(summary.conflicted).toHaveLength(0);
    expect(summary.totalRows).toBe(1);
  });

  it("marks a metric that exactly matches an existing row as skipped", () => {
    const summary = computeDryRunSyncPlan([metric()], [existingRow()]);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.added).toHaveLength(0);
    expect(summary.conflicted).toHaveLength(0);
  });

  it("tolerates small floating point drift in apy when matching", () => {
    const summary = computeDryRunSyncPlan(
      [metric({ apy: 12.341 })],
      [existingRow({ apy: "12.34" })],
    );
    expect(summary.skipped).toHaveLength(1);
  });

  it("marks a metric that overwrites a placeholder row as updated", () => {
    const summary = computeDryRunSyncPlan(
      [metric({ currentValue: 2000n })],
      [existingRow({ currentValue: "0", isPlaceholder: true })],
    );
    expect(summary.updated).toHaveLength(1);
    expect(summary.conflicted).toHaveLength(0);
  });

  it("flags a real value disagreement against a non-placeholder row as conflicted", () => {
    const summary = computeDryRunSyncPlan(
      [metric({ currentValue: 2000n })],
      [existingRow({ currentValue: "999" })],
    );
    expect(summary.conflicted).toHaveLength(1);
    expect(summary.conflicted[0].reason).toMatch(/different values/i);
  });

  it("keys conflicts by wallet, vault, asset, and timestamp independently", () => {
    // Same day, same vault, but a different wallet and a different asset —
    // these must not collide with each other or with the existing row.
    const summary = computeDryRunSyncPlan(
      [
        metric({ walletAddress: "GBOB", currentValue: 5000n }),
        metric({ asset: "XLM", currentValue: 7000n }),
      ],
      [existingRow()],
    );
    expect(summary.added).toHaveLength(2);
    expect(summary.conflicted).toHaveLength(0);
  });

  it("flags a within-batch duplicate key as conflicted", () => {
    const summary = computeDryRunSyncPlan(
      [metric({ currentValue: 1050n }), metric({ currentValue: 9999n })],
      [],
    );
    expect(summary.added).toHaveLength(1);
    expect(summary.conflicted).toHaveLength(1);
    expect(summary.conflicted[0].reason).toMatch(/duplicate entry/i);
  });

  it("counts totalRows across all buckets", () => {
    const summary = computeDryRunSyncPlan(
      [
        metric({ walletAddress: "GNEW" }), // added
        metric(), // skipped (matches existingRow())
      ],
      [existingRow()],
    );
    expect(summary.totalRows).toBe(2);
    expect(summary.added.length + summary.updated.length + summary.skipped.length + summary.conflicted.length).toBe(2);
  });

  it("handles an empty metrics batch", () => {
    const summary = computeDryRunSyncPlan([], [existingRow()]);
    expect(summary.totalRows).toBe(0);
    expect(summary.added).toHaveLength(0);
  });
});
