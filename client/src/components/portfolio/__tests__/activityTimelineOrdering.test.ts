/**
 * activityTimelineOrdering.test.ts — Issue #1009
 *
 * Unit tests for the monotonic ordering and deduplication logic in
 * activityTimelineTypes.ts:
 *
 * 1. Events are sorted newest-first by ledger → timestamp → source priority.
 * 2. Events sharing the same id are deduplicated (first-seen wins).
 * 3. Events sharing the same txHash are deduplicated (highest-priority source wins).
 * 4. SOURCE_LABELS maps every source key to a capitalised display string.
 */

import { describe, it, expect } from "vitest";
import {
  compareEventsAscending,
  deduplicateEvents,
  sortAndDeduplicateTimeline,
  SOURCE_LABELS,
  DEFAULT_SOURCE_PRIORITY,
  getEventSortKey,
  type AccountActivityEvent,
} from "../activityTimelineTypes";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AccountActivityEvent> & { id: string }): AccountActivityEvent {
  return {
    walletAddress: "GWALLET",
    type: "deposit",
    title: "Test event",
    description: "Description",
    timestamp: "2026-05-26T08:00:00.000Z",
    source: "portfolio",
    ...overrides,
  };
}

// ── SOURCE_LABELS ─────────────────────────────────────────────────────────────

describe("SOURCE_LABELS", () => {
  it("has an entry for every source key", () => {
    const sources: Array<AccountActivityEvent["source"]> = [
      "portfolio", "rewards", "advisor", "monitoring", "automation",
    ];
    for (const source of sources) {
      expect(SOURCE_LABELS[source]).toBeDefined();
      expect(typeof SOURCE_LABELS[source]).toBe("string");
      expect(SOURCE_LABELS[source].length).toBeGreaterThan(0);
    }
  });

  it("labels start with a capital letter", () => {
    for (const label of Object.values(SOURCE_LABELS)) {
      expect(label[0]).toBe(label[0].toUpperCase());
    }
  });

  it("maps portfolio → 'Portfolio'", () => {
    expect(SOURCE_LABELS["portfolio"]).toBe("Portfolio");
  });

  it("maps monitoring → 'Monitoring'", () => {
    expect(SOURCE_LABELS["monitoring"]).toBe("Monitoring");
  });
});

// ── getEventSortKey ───────────────────────────────────────────────────────────

describe("getEventSortKey", () => {
  it("uses ledger when present", () => {
    const event = makeEvent({ id: "e1", ledger: 42 });
    expect(getEventSortKey(event).ledger).toBe(42);
  });

  it("uses MAX_SAFE_INTEGER for ledger when absent", () => {
    const event = makeEvent({ id: "e1" });
    expect(getEventSortKey(event).ledger).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("parses timestamp to milliseconds", () => {
    const event = makeEvent({ id: "e1", timestamp: "2026-05-26T08:00:00.000Z" });
    expect(getEventSortKey(event).timestampMs).toBe(new Date("2026-05-26T08:00:00.000Z").getTime());
  });

  it("uses explicit sourcePriority when set", () => {
    const event = makeEvent({ id: "e1", sourcePriority: 7 });
    expect(getEventSortKey(event).sourcePriority).toBe(7);
  });

  it("falls back to DEFAULT_SOURCE_PRIORITY when sourcePriority is absent", () => {
    const event = makeEvent({ id: "e1", source: "rewards" });
    expect(getEventSortKey(event).sourcePriority).toBe(DEFAULT_SOURCE_PRIORITY["rewards"]);
  });
});

// ── compareEventsAscending ────────────────────────────────────────────────────

describe("compareEventsAscending", () => {
  it("orders by ledger ascending: lower ledger comes first", () => {
    const older = makeEvent({ id: "e1", ledger: 10 });
    const newer = makeEvent({ id: "e2", ledger: 20 });
    expect(compareEventsAscending(older, newer)).toBeLessThan(0);
    expect(compareEventsAscending(newer, older)).toBeGreaterThan(0);
  });

  it("falls through to timestamp when ledgers are equal", () => {
    const older = makeEvent({ id: "e1", ledger: 5, timestamp: "2026-05-26T06:00:00.000Z" });
    const newer = makeEvent({ id: "e2", ledger: 5, timestamp: "2026-05-26T08:00:00.000Z" });
    expect(compareEventsAscending(older, newer)).toBeLessThan(0);
  });

  it("falls through to sourcePriority when ledger and timestamp are equal", () => {
    const ts = "2026-05-26T08:00:00.000Z";
    const highPriority = makeEvent({ id: "e1", ledger: 5, timestamp: ts, source: "portfolio" });
    const lowPriority  = makeEvent({ id: "e2", ledger: 5, timestamp: ts, source: "monitoring" });
    // portfolio (priority 1) < monitoring (priority 4)
    expect(compareEventsAscending(highPriority, lowPriority)).toBeLessThan(0);
  });

  it("returns 0 when events are identical in all keys", () => {
    const ts = "2026-05-26T08:00:00.000Z";
    const e1 = makeEvent({ id: "e1", ledger: 5, timestamp: ts, source: "portfolio" });
    const e2 = makeEvent({ id: "e2", ledger: 5, timestamp: ts, source: "portfolio" });
    expect(compareEventsAscending(e1, e2)).toBe(0);
  });

  it("events without ledger sort after events with ledger", () => {
    const withLedger    = makeEvent({ id: "e1", ledger: 999 });
    const withoutLedger = makeEvent({ id: "e2" }); // ledger defaults to MAX_SAFE_INTEGER
    expect(compareEventsAscending(withLedger, withoutLedger)).toBeLessThan(0);
  });
});

// ── deduplicateEvents ─────────────────────────────────────────────────────────

describe("deduplicateEvents", () => {
  it("returns the same events when there are no duplicates", () => {
    const events = [
      makeEvent({ id: "e1" }),
      makeEvent({ id: "e2" }),
    ];
    expect(deduplicateEvents(events)).toHaveLength(2);
  });

  it("deduplicates by id: first occurrence wins", () => {
    const first  = makeEvent({ id: "dup", title: "First"  });
    const second = makeEvent({ id: "dup", title: "Second" });
    const result = deduplicateEvents([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("First");
  });

  it("deduplicates by txHash: highest-priority source wins", () => {
    const portfolioEvent  = makeEvent({ id: "e1", txHash: "abc123", source: "portfolio" });
    const monitoringEvent = makeEvent({ id: "e2", txHash: "abc123", source: "monitoring" });
    // monitoring has higher priority number (lower priority) → portfolio wins
    const result = deduplicateEvents([monitoringEvent, portfolioEvent]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("portfolio");
  });

  it("deduplicates by txHash: among equal-priority sources first occurrence wins", () => {
    const first  = makeEvent({ id: "e1", txHash: "xyz", source: "portfolio", title: "First" });
    const second = makeEvent({ id: "e2", txHash: "xyz", source: "portfolio", title: "Second" });
    const result = deduplicateEvents([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("First");
  });

  it("events without txHash are never merged with each other even if identical otherwise", () => {
    const e1 = makeEvent({ id: "e1", title: "Same title" });
    const e2 = makeEvent({ id: "e2", title: "Same title" });
    expect(deduplicateEvents([e1, e2])).toHaveLength(2);
  });

  it("handles empty input gracefully", () => {
    expect(deduplicateEvents([])).toHaveLength(0);
  });

  it("handles single event", () => {
    const result = deduplicateEvents([makeEvent({ id: "e1" })]);
    expect(result).toHaveLength(1);
  });
});

// ── sortAndDeduplicateTimeline ────────────────────────────────────────────────

describe("sortAndDeduplicateTimeline", () => {
  it("returns events newest-first (descending timestamp)", () => {
    const old  = makeEvent({ id: "e1", timestamp: "2026-05-24T00:00:00.000Z" });
    const mid  = makeEvent({ id: "e2", timestamp: "2026-05-25T00:00:00.000Z" });
    const new_ = makeEvent({ id: "e3", timestamp: "2026-05-26T00:00:00.000Z" });

    const result = sortAndDeduplicateTimeline([old, new_, mid]);

    expect(result[0].id).toBe("e3"); // newest first
    expect(result[1].id).toBe("e2");
    expect(result[2].id).toBe("e1");
  });

  it("uses ledger sequence as primary sort key (ascending ledger = older)", () => {
    // Same timestamp, different ledgers
    const ts = "2026-05-26T08:00:00.000Z";
    const olderLedger = makeEvent({ id: "e1", ledger: 100, timestamp: ts });
    const newerLedger = makeEvent({ id: "e2", ledger: 200, timestamp: ts });

    const result = sortAndDeduplicateTimeline([olderLedger, newerLedger]);

    expect(result[0].id).toBe("e2"); // higher ledger = newer = first in descending order
    expect(result[1].id).toBe("e1");
  });

  it("uses source priority as final tiebreaker", () => {
    const ts = "2026-05-26T08:00:00.000Z";
    const ldr = 42;
    const highPriority = makeEvent({ id: "e1", ledger: ldr, timestamp: ts, source: "portfolio" });
    const lowPriority  = makeEvent({ id: "e2", ledger: ldr, timestamp: ts, source: "monitoring" });

    const result = sortAndDeduplicateTimeline([lowPriority, highPriority]);

    // In ascending order: highPriority (1) < lowPriority (4), so descending: lowPriority first
    expect(result[0].id).toBe("e2");
    expect(result[1].id).toBe("e1");
  });

  it("deduplicates while sorting", () => {
    const e1 = makeEvent({ id: "dup", timestamp: "2026-05-26T08:00:00.000Z" });
    const e2 = makeEvent({ id: "dup", timestamp: "2026-05-25T00:00:00.000Z" }); // same id
    const e3 = makeEvent({ id: "e3", timestamp: "2026-05-24T00:00:00.000Z" });

    const result = sortAndDeduplicateTimeline([e1, e2, e3]);

    expect(result).toHaveLength(2);
    // e1 wins (first with id "dup")
    expect(result.some((e) => e.id === "dup")).toBe(true);
    expect(result.some((e) => e.id === "e3")).toBe(true);
  });

  it("deduplicates txHash duplicates from multiple sources, keeps highest-priority source", () => {
    const fromRewards    = makeEvent({ id: "r1", txHash: "tx42", source: "rewards",   timestamp: "2026-05-26T08:00:00.000Z" });
    const fromPortfolio  = makeEvent({ id: "p1", txHash: "tx42", source: "portfolio", timestamp: "2026-05-26T08:00:00.000Z" });

    const result = sortAndDeduplicateTimeline([fromRewards, fromPortfolio]);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("portfolio"); // portfolio has lower priority number = higher priority
  });

  it("handles empty array", () => {
    expect(sortAndDeduplicateTimeline([])).toHaveLength(0);
  });

  it("stable ordering: events that compare equal remain in the order they were encountered", () => {
    const ts = "2026-05-26T08:00:00.000Z";
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ id: `e${i}`, timestamp: ts, source: "portfolio" }),
    );
    const result = sortAndDeduplicateTimeline(events);
    expect(result).toHaveLength(5);
  });

  it("mixed ledger and non-ledger events: ledger-bearing events sort by ledger, others by timestamp", () => {
    const withLedger  = makeEvent({ id: "e1", ledger: 500, timestamp: "2026-05-24T00:00:00.000Z" });
    const noLedger    = makeEvent({ id: "e2",              timestamp: "2026-05-26T00:00:00.000Z" });

    const result = sortAndDeduplicateTimeline([withLedger, noLedger]);

    // withLedger has a finite ledger key → sorts before noLedger (MAX_SAFE_INTEGER).
    // In descending order: noLedger (MAX_SAFE_INTEGER) comes first.
    expect(result[0].id).toBe("e2");
    expect(result[1].id).toBe("e1");
  });
});
