import { describe, it, expect } from "vitest";
import {
  DEFAULT_DRIFT_WINDOW_MS,
  describeDriftDigestItem,
  groupDriftAlerts,
  type DriftAlertInput,
} from "./driftDigestGrouping";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const alert = (o: Partial<DriftAlertInput> = {}): DriftAlertInput => ({
  portfolioId: "p1",
  asset: "XLM",
  severity: "high",
  cause: "allocation drift",
  createdAt: at(0),
  ...o,
});

describe("groupDriftAlerts", () => {
  it("groups repeated drift alerts into one item with count and latest timestamp", () => {
    const { items, summary } = groupDriftAlerts([
      alert({ createdAt: at(0) }),
      alert({ createdAt: at(60_000) }),
      alert({ createdAt: at(120_000) }),
    ]);
    expect(items).toHaveLength(1);
    const g = items[0];
    expect(g.kind).toBe("group");
    if (g.kind === "group") {
      expect(g.count).toBe(3);
      expect(g.firstAt).toBe(at(0));
      expect(g.latestAt).toBe(at(120_000));
    }
    expect(summary).toEqual({ totalAlerts: 3, digestItems: 1, groupedItems: 1, collapsedAlerts: 2 });
  });

  it("preserves the latest timestamp regardless of input order", () => {
    const { items } = groupDriftAlerts([
      alert({ createdAt: at(120_000) }),
      alert({ createdAt: at(0) }),
      alert({ createdAt: at(60_000) }),
    ]);
    expect(items[0].kind === "group" && items[0].latestAt).toBe(at(120_000));
  });

  it("keeps distinct causes separate", () => {
    const { items } = groupDriftAlerts([
      alert({ cause: "allocation drift" }),
      alert({ cause: "price deviation" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "single")).toBe(true);
  });

  it("keeps different severity, asset and portfolio separate", () => {
    const { items } = groupDriftAlerts([
      alert(),
      alert({ severity: "low" }),
      alert({ asset: "USDC" }),
      alert({ portfolioId: "p2" }),
    ]);
    expect(items).toHaveLength(4);
  });

  it("matches keys case- and whitespace-insensitively", () => {
    const { items } = groupDriftAlerts([alert({ asset: "xlm " }), alert({ asset: "XLM" })]);
    expect(items).toHaveLength(1);
  });

  it("falls back to message when there is no cause", () => {
    const { items } = groupDriftAlerts([
      alert({ cause: undefined, message: "A" }),
      alert({ cause: undefined, message: "A" }),
      alert({ cause: undefined, message: "B" }),
    ]);
    expect(items).toHaveLength(2);
  });

  it("boundary: exactly windowMs groups, one ms more starts a new group", () => {
    const w = DEFAULT_DRIFT_WINDOW_MS;
    expect(groupDriftAlerts([alert({ createdAt: at(0) }), alert({ createdAt: at(w) })]).items).toHaveLength(1);
    expect(groupDriftAlerts([alert({ createdAt: at(0) }), alert({ createdAt: at(w + 1) })]).items).toHaveLength(2);
  });

  it("respects a custom window", () => {
    const list = [alert({ createdAt: at(0) }), alert({ createdAt: at(5_000) })];
    expect(groupDriftAlerts(list, { windowMs: 1_000 }).items).toHaveLength(2);
    expect(groupDriftAlerts(list, { windowMs: 10_000 }).items).toHaveLength(1);
  });

  it("ungrouped: a single alert stays a single item and is passed through unchanged", () => {
    const a = alert();
    const { items, summary } = groupDriftAlerts([a]);
    expect(items).toEqual([{ kind: "single", alert: a }]);
    expect(summary.collapsedAlerts).toBe(0);
  });

  it("handles empty input", () => {
    expect(groupDriftAlerts([])).toEqual({
      items: [],
      summary: { totalAlerts: 0, digestItems: 0, groupedItems: 0, collapsedAlerts: 0 },
    });
  });

  it("accepts Date objects and keeps invalid timestamps as singles", () => {
    const { items } = groupDriftAlerts([
      alert({ createdAt: new Date(T0) }),
      alert({ createdAt: new Date(T0 + 1000) }),
      alert({ createdAt: "not-a-date" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[1].kind).toBe("single");
  });

  it("orders items newest-first and does not mutate the input", () => {
    const input = [
      alert({ asset: "A", createdAt: at(0) }),
      alert({ asset: "B", createdAt: at(1000) }),
    ];
    const copy = JSON.parse(JSON.stringify(input));
    const { items } = groupDriftAlerts(input);
    expect(items[0].kind === "single" && items[0].alert.asset).toBe("B");
    expect(input).toEqual(copy);
  });

  it("mixed digest: grouped and ungrouped items together", () => {
    const { items, summary } = groupDriftAlerts([
      alert({ createdAt: at(0) }),
      alert({ createdAt: at(1000) }),
      alert({ asset: "USDC", createdAt: at(2000) }),
    ]);
    expect(items.map((i) => i.kind).sort()).toEqual(["group", "single"]);
    expect(summary).toEqual({ totalAlerts: 3, digestItems: 2, groupedItems: 1, collapsedAlerts: 1 });
  });
});

describe("describeDriftDigestItem", () => {
  it("shows count and latest time for groups only", () => {
    const { items } = groupDriftAlerts([alert({ createdAt: at(0) }), alert({ createdAt: at(1000) })]);
    expect(describeDriftDigestItem(items[0])).toContain("(x2, latest " + at(1000) + ")");
    const single = groupDriftAlerts([alert()]).items[0];
    expect(describeDriftDigestItem(single)).not.toContain("(x");
  });
});