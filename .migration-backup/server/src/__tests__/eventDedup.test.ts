/**
 * Contract event deduplication for repeated ledger ingestion (#1361).
 */
import {
  computeEventDedupKey,
  dedupeBatch,
  EventDedupTracker,
} from "../indexer/eventDedup";

const baseEvent = {
  contractId: "CVAULT",
  ledger: 100,
  txHash: "abc123",
  topic: "topic-xdr",
  data: "data-xdr",
};

describe("computeEventDedupKey", () => {
  it("builds a deterministic colon-separated identity", () => {
    const key = computeEventDedupKey(baseEvent);
    expect(key).toBe("CVAULT:100:abc123:topic-xdr:data-xdr");
    expect(computeEventDedupKey({ ...baseEvent })).toBe(key);
  });

  it("changes when any event component differs", () => {
    const key = computeEventDedupKey(baseEvent);
    expect(computeEventDedupKey({ ...baseEvent, ledger: 101 })).not.toBe(key);
    expect(computeEventDedupKey({ ...baseEvent, txHash: "xyz" })).not.toBe(key);
    expect(computeEventDedupKey({ ...baseEvent, topic: "other" })).not.toBe(key);
    expect(computeEventDedupKey({ ...baseEvent, data: "other" })).not.toBe(key);
    expect(computeEventDedupKey({ ...baseEvent, contractId: "OTHER" })).not.toBe(
      key,
    );
  });
});

describe("EventDedupTracker", () => {
  it("flags the first sighting as unique and later re-deliveries as duplicates", () => {
    const tracker = new EventDedupTracker({ windowMs: 60_000 });
    const key = computeEventDedupKey(baseEvent);

    expect(tracker.checkAndRecord(key)).toBe(false);
    expect(tracker.checkAndRecord(key)).toBe(true);
    expect(tracker.checkAndRecord(key)).toBe(true);

    const stats = tracker.stats();
    expect(stats.uniqueSeen).toBe(1);
    expect(stats.duplicatesSkipped).toBe(2);
    expect(stats.trackedKeys).toBe(1);
    expect(stats.windowMs).toBe(60_000);
  });

  it("treats different keys independently", () => {
    const tracker = new EventDedupTracker();
    expect(tracker.checkAndRecord(computeEventDedupKey(baseEvent))).toBe(false);
    expect(
      tracker.checkAndRecord(
        computeEventDedupKey({ ...baseEvent, ledger: 101 }),
      ),
    ).toBe(false);
    expect(tracker.stats().duplicatesSkipped).toBe(0);
  });

  it("expires keys after the suppression window (clock-injected)", () => {
    let now = 1_000_000;
    const tracker = new EventDedupTracker({
      windowMs: 60_000,
      now: () => now,
    });
    const key = computeEventDedupKey(baseEvent);

    expect(tracker.checkAndRecord(key)).toBe(false);
    expect(tracker.checkAndRecord(key)).toBe(true);

    now += 60_000;
    // Window elapsed: the re-delivery is treated as first-seen again.
    expect(tracker.checkAndRecord(key)).toBe(false);
    expect(tracker.stats().uniqueSeen).toBe(2);
  });

  it("evicts oldest keys beyond maxEntries while keeping newest", () => {
    const tracker = new EventDedupTracker({ maxEntries: 2 });
    expect(tracker.checkAndRecord("k1")).toBe(false);
    expect(tracker.checkAndRecord("k2")).toBe(false);
    expect(tracker.checkAndRecord("k3")).toBe(false);
    expect(tracker.stats().trackedKeys).toBe(2);

    // k1 was evicted, so it is first-seen again; k3 still dedups.
    expect(tracker.checkAndRecord("k1")).toBe(false);
    expect(tracker.checkAndRecord("k3")).toBe(true);
  });

  it("reset clears keys and counters", () => {
    const tracker = new EventDedupTracker();
    tracker.checkAndRecord("k1");
    tracker.checkAndRecord("k1");
    tracker.reset();

    const stats = tracker.stats();
    expect(stats.trackedKeys).toBe(0);
    expect(stats.uniqueSeen).toBe(0);
    expect(stats.duplicatesSkipped).toBe(0);
    expect(tracker.checkAndRecord("k1")).toBe(false);
  });
});

describe("dedupeBatch", () => {
  it("keeps first occurrence, preserves order, and reports dropped keys", () => {
    const items = [
      { id: "a", ledger: 1 },
      { id: "b", ledger: 2 },
      { id: "a", ledger: 3 },
      { id: "c", ledger: 4 },
      { id: "b", ledger: 5 },
    ];

    const { unique, duplicateKeys } = dedupeBatch(items, (item) => item.id);

    expect(unique.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(unique[0].ledger).toBe(1);
    expect(unique[1].ledger).toBe(2);
    expect(duplicateKeys).toEqual(["a", "b"]);
  });

  it("returns all items untouched when there are no repeats", () => {
    const { unique, duplicateKeys } = dedupeBatch(
      [{ id: "x" }, { id: "y" }],
      (item) => item.id,
    );
    expect(unique).toHaveLength(2);
    expect(duplicateKeys).toEqual([]);
  });
});
