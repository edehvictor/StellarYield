/**
 * Protocol fee history tests (#1147).
 */
import {
  recordFeeSnapshotIfChanged,
  getFeeHistory,
  resetFeeHistory,
  MAX_FEE_HISTORY_ENTRIES,
} from "../protocolFeeHistoryService";

beforeEach(() => {
  resetFeeHistory();
});

describe("getFeeHistory", () => {
  it("returns an empty array when nothing has been recorded for the protocol", () => {
    expect(getFeeHistory("NeverSeen")).toEqual([]);
  });

  it("returns recorded snapshots newest-first", () => {
    recordFeeSnapshotIfChanged("Blend", 1000, "2026-01-01T00:00:00.000Z");
    recordFeeSnapshotIfChanged("Blend", 1200, "2026-01-02T00:00:00.000Z");
    recordFeeSnapshotIfChanged("Blend", 900, "2026-01-03T00:00:00.000Z");

    const history = getFeeHistory("Blend");
    expect(history).toEqual([
      { feeBps: 900, changedAt: "2026-01-03T00:00:00.000Z" },
      { feeBps: 1200, changedAt: "2026-01-02T00:00:00.000Z" },
      { feeBps: 1000, changedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("keeps histories for different protocols independent", () => {
    recordFeeSnapshotIfChanged("Blend", 1000, "2026-01-01T00:00:00.000Z");
    recordFeeSnapshotIfChanged("Soroswap", 30, "2026-01-01T00:00:00.000Z");

    expect(getFeeHistory("Blend")).toEqual([{ feeBps: 1000, changedAt: "2026-01-01T00:00:00.000Z" }]);
    expect(getFeeHistory("Soroswap")).toEqual([{ feeBps: 30, changedAt: "2026-01-01T00:00:00.000Z" }]);
  });
});

describe("recordFeeSnapshotIfChanged", () => {
  it("does not record a duplicate entry when the fee is unchanged", () => {
    recordFeeSnapshotIfChanged("Blend", 1000, "2026-01-01T00:00:00.000Z");
    recordFeeSnapshotIfChanged("Blend", 1000, "2026-01-01T00:05:00.000Z");
    recordFeeSnapshotIfChanged("Blend", 1000, "2026-01-01T00:10:00.000Z");

    expect(getFeeHistory("Blend")).toHaveLength(1);
  });

  it("records a new entry each time the fee actually changes", () => {
    recordFeeSnapshotIfChanged("Blend", 1000, "2026-01-01T00:00:00.000Z");
    recordFeeSnapshotIfChanged("Blend", 1000, "2026-01-01T00:05:00.000Z"); // no-op
    recordFeeSnapshotIfChanged("Blend", 1100, "2026-01-01T00:10:00.000Z"); // change
    recordFeeSnapshotIfChanged("Blend", 1100, "2026-01-01T00:15:00.000Z"); // no-op
    recordFeeSnapshotIfChanged("Blend", 900, "2026-01-01T00:20:00.000Z"); // change

    expect(getFeeHistory("Blend")).toHaveLength(3);
  });

  it("ignores invalid input rather than recording garbage", () => {
    recordFeeSnapshotIfChanged("", 1000);
    recordFeeSnapshotIfChanged("Blend", NaN);
    expect(getFeeHistory("Blend")).toEqual([]);
    expect(getFeeHistory("")).toEqual([]);
  });

  it("caps retained history at MAX_FEE_HISTORY_ENTRIES, dropping the oldest", () => {
    for (let i = 0; i < MAX_FEE_HISTORY_ENTRIES + 5; i++) {
      recordFeeSnapshotIfChanged("Blend", i, `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`);
    }

    const history = getFeeHistory("Blend");
    expect(history).toHaveLength(MAX_FEE_HISTORY_ENTRIES);
    // Newest-first: the most recent write (highest i) should be first.
    expect(history[0].feeBps).toBe(MAX_FEE_HISTORY_ENTRIES + 4);
    // The oldest 5 entries should have been dropped.
    expect(history.some((h) => h.feeBps < 5)).toBe(false);
  });
});
