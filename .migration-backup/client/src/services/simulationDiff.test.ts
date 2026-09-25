import { describe, it, expect } from "vitest";
import {
  buildDepositSimulationDiff,
  computeSnapshotDiff,
  type TransactionSimulationDiff,
} from "./simulationDiff";

describe("computeSnapshotDiff", () => {
  it("returns no_baseline when the before snapshot is missing", () => {
    expect(computeSnapshotDiff(null, { shares: 10 })).toEqual({
      status: "empty",
      reason: "no_baseline",
    });
  });

  it("returns no_simulation when the after snapshot is missing", () => {
    expect(computeSnapshotDiff({ shares: 10 }, null)).toEqual({
      status: "empty",
      reason: "no_simulation",
    });
  });

  it("returns no_fields when nothing changed", () => {
    expect(
      computeSnapshotDiff({ shares: 10, fee: 1 }, { shares: 10, fee: 1 }),
    ).toEqual({
      status: "empty",
      reason: "no_fields",
    });
  });

  it("classifies numeric increases and decreases", () => {
    const diff = computeSnapshotDiff(
      { shares: 100, balance: 1000 },
      { shares: 120.5, balance: 980 },
    ) as Extract<TransactionSimulationDiff, { status: "ready" }>;
    expect(diff.status).toBe("ready");
    expect(diff.changes).toEqual([
      { field: "shares", before: 100, after: 120.5, kind: "increase" },
      { field: "balance", before: 1000, after: 980, kind: "decrease" },
    ]);
  });

  it("classifies added and removed fields", () => {
    const diff = computeSnapshotDiff({ a: 1 }, { a: 2, b: 3 }) as Extract<
      TransactionSimulationDiff,
      { status: "ready" }
    >;
    expect(diff.status).toBe("ready");
    const kinds = diff.changes.map((c) => c.kind);
    expect(kinds).toContain("new");
    expect(kinds).toContain("increase");
  });
});

describe("buildDepositSimulationDiff", () => {
  it("produces an empty state while the simulation has no result yet", () => {
    expect(
      buildDepositSimulationDiff({
        amountUsd: 500,
        expectedShares: null,
        sharesBefore: 100,
      }),
    ).toEqual({ status: "empty", reason: "no_simulation" });
  });

  it("produces an empty state without a baseline", () => {
    expect(
      buildDepositSimulationDiff({
        amountUsd: 500,
        expectedShares: 590,
        sharesBefore: null,
      }),
    ).toEqual({ status: "empty", reason: "no_simulation" });
  });

  it("shows shares increasing and inbound amount reaching zero on a ready diff", () => {
    const diff = buildDepositSimulationDiff({
      amountUsd: 500,
      expectedShares: 590,
      sharesBefore: 100,
    }) as Extract<TransactionSimulationDiff, { status: "ready" }>;
    expect(diff.status).toBe("ready");
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        { field: "vaultShares", before: 100, after: 590, kind: "increase" },
        {
          field: "inboundAmountUsd",
          before: 500,
          after: 0,
          kind: "decrease",
        },
      ]),
    );
  });
});