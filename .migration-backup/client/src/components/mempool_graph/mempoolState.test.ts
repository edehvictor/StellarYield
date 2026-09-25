import { describe, it, expect } from "vitest";
import {
  classifyTxState,
  getLatencyBucket,
  buildTxWithState,
  isStalledWithResubmission,
  partitionByState,
  STALLED_THRESHOLD_MS,
  DELAYED_THRESHOLD_MS,
  LATENCY_BUCKETS,
} from "./mempoolState";

describe("classifyTxState", () => {
  it("returns healthy for a recently submitted tx", () => {
    expect(classifyTxState(0)).toBe("healthy");
    expect(classifyTxState(1_000)).toBe("healthy");
    expect(classifyTxState(DELAYED_THRESHOLD_MS - 1)).toBe("healthy");
  });

  it("returns delayed at the delayed threshold", () => {
    expect(classifyTxState(DELAYED_THRESHOLD_MS)).toBe("delayed");
    expect(classifyTxState(DELAYED_THRESHOLD_MS + 1_000)).toBe("delayed");
    expect(classifyTxState(STALLED_THRESHOLD_MS - 1)).toBe("delayed");
  });

  it("returns stalled at the stalled threshold", () => {
    expect(classifyTxState(STALLED_THRESHOLD_MS)).toBe("stalled");
    expect(classifyTxState(STALLED_THRESHOLD_MS + 60_000)).toBe("stalled");
  });

  it("handles very large ages as stalled", () => {
    expect(classifyTxState(Number.MAX_SAFE_INTEGER)).toBe("stalled");
  });
});

describe("getLatencyBucket", () => {
  it("returns fast for ages within 5 s", () => {
    expect(getLatencyBucket(0)).toBe("fast");
    expect(getLatencyBucket(5_000)).toBe("fast");
  });

  it("returns normal for ages between 5 s and 30 s", () => {
    expect(getLatencyBucket(5_001)).toBe("normal");
    expect(getLatencyBucket(30_000)).toBe("normal");
  });

  it("returns slow for ages between 30 s and 120 s", () => {
    expect(getLatencyBucket(30_001)).toBe("slow");
    expect(getLatencyBucket(STALLED_THRESHOLD_MS)).toBe("slow");
  });

  it("returns stalled for ages beyond all buckets", () => {
    expect(getLatencyBucket(STALLED_THRESHOLD_MS + 1)).toBe("stalled");
  });

  it("covers all defined bucket labels", () => {
    const labels = LATENCY_BUCKETS.map((b) => b.label);
    expect(labels).toContain("fast");
    expect(labels).toContain("normal");
    expect(labels).toContain("slow");
  });
});

describe("buildTxWithState", () => {
  it("builds a healthy tx correctly", () => {
    const tx = buildTxWithState("abc", 1_000);
    expect(tx.id).toBe("abc");
    expect(tx.ageMs).toBe(1_000);
    expect(tx.state).toBe("healthy");
    expect(tx.latencyBucket).toBe("fast");
    expect(tx.resubmissionCount).toBe(0);
  });

  it("builds a delayed tx correctly", () => {
    const tx = buildTxWithState("def", 60_000);
    expect(tx.state).toBe("delayed");
    expect(tx.latencyBucket).toBe("slow");
  });

  it("builds a stalled tx with resubmission count", () => {
    const tx = buildTxWithState("xyz", 200_000, 3);
    expect(tx.state).toBe("stalled");
    expect(tx.resubmissionCount).toBe(3);
    expect(tx.latencyBucket).toBe("stalled");
  });

  it("defaults resubmission count to 0", () => {
    expect(buildTxWithState("t1", 0).resubmissionCount).toBe(0);
  });
});

describe("isStalledWithResubmission", () => {
  it("returns true for stalled tx with resubmissions", () => {
    const tx = buildTxWithState("a", 200_000, 2);
    expect(isStalledWithResubmission(tx)).toBe(true);
  });

  it("returns false for stalled tx with no resubmissions", () => {
    const tx = buildTxWithState("b", 200_000, 0);
    expect(isStalledWithResubmission(tx)).toBe(false);
  });

  it("returns false for delayed tx even with resubmissions", () => {
    const tx = buildTxWithState("c", 60_000, 1);
    expect(isStalledWithResubmission(tx)).toBe(false);
  });

  it("returns false for healthy tx", () => {
    const tx = buildTxWithState("d", 1_000, 5);
    expect(isStalledWithResubmission(tx)).toBe(false);
  });
});

describe("partitionByState", () => {
  it("groups transactions into healthy, delayed, and stalled buckets", () => {
    const txs = [
      buildTxWithState("h1", 1_000),
      buildTxWithState("h2", 10_000),
      buildTxWithState("d1", 60_000),
      buildTxWithState("s1", 200_000),
      buildTxWithState("s2", 300_000),
    ];

    const { healthy, delayed, stalled } = partitionByState(txs);

    expect(healthy.map((t) => t.id)).toEqual(["h1", "h2"]);
    expect(delayed.map((t) => t.id)).toEqual(["d1"]);
    expect(stalled.map((t) => t.id)).toEqual(["s1", "s2"]);
  });

  it("returns empty arrays when no transactions match a state", () => {
    const txs = [buildTxWithState("x", 1_000)];
    const { delayed, stalled } = partitionByState(txs);
    expect(delayed).toHaveLength(0);
    expect(stalled).toHaveLength(0);
  });

  it("handles an empty transaction list", () => {
    const { healthy, delayed, stalled } = partitionByState([]);
    expect(healthy).toHaveLength(0);
    expect(delayed).toHaveLength(0);
    expect(stalled).toHaveLength(0);
  });
});
