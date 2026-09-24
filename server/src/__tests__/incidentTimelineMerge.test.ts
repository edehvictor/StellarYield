import {
  buildMergedIncidentTimeline,
  incidentDuplicateKey,
  mergeIncidentDuplicates,
  IncidentTimelineRecord,
  DEFAULT_DUPLICATE_WINDOW_MS,
} from "../services/incidentTimelineMerge";
import { AlertSeverity } from "../utils/alertSeverity";

function record(overrides: Partial<IncidentTimelineRecord> = {}): IncidentTimelineRecord {
  return {
    id: "rec-1",
    source: "on-chain-monitor",
    protocol: "Blend",
    type: "PAUSE",
    severity: "HIGH",
    title: "Blend vault paused",
    description: "Vault paused by guardian",
    affectedVaults: ["Vault1"],
    startedAt: new Date("2026-05-01T00:00:00Z"),
    resolved: false,
    resolvedAt: null,
    postmortemUrl: null,
    ...overrides,
  };
}

describe("incidentDuplicateKey", () => {
  it("is stable for the same protocol/type/time bucket regardless of input order", () => {
    const a = record({ startedAt: new Date("2026-05-01T00:00:00Z") });
    const b = record({ startedAt: new Date("2026-05-01T00:01:00Z") }); // within 5-min bucket
    expect(incidentDuplicateKey(a)).toBe(incidentDuplicateKey(b));
  });

  it("differs across protocol, type, or time bucket", () => {
    const base = record();
    expect(incidentDuplicateKey(base)).not.toBe(incidentDuplicateKey({ ...base, protocol: "Soroswap" }));
    expect(incidentDuplicateKey(base)).not.toBe(incidentDuplicateKey({ ...base, type: "DEPEG" }));
    expect(incidentDuplicateKey(base)).not.toBe(
      incidentDuplicateKey({ ...base, startedAt: new Date("2026-06-01T00:00:00Z") }),
    );
  });

  it("is case-insensitive on protocol and type", () => {
    const a = record({ protocol: "Blend", type: "pause" });
    const b = record({ protocol: "blend", type: "PAUSE" });
    expect(incidentDuplicateKey(a)).toBe(incidentDuplicateKey(b));
  });
});

describe("mergeIncidentDuplicates (conflict matrix)", () => {
  it("merges an exact duplicate reported by two sources into one entry with combined sources", () => {
    const a = record({ id: "a", source: "on-chain-monitor" });
    const b = record({ id: "b", source: "ops-manual" });

    const merged = mergeIncidentDuplicates([a, b]);

    expect(merged.sources).toEqual(["ops-manual", "on-chain-monitor"].sort());
    expect(merged.mergedFrom).toHaveLength(2);
  });

  it("resolves conflicting severity by taking the highest severity (most-severe-wins)", () => {
    const low = record({ id: "a", source: "monitor-a", severity: "LOW" });
    const critical = record({ id: "b", source: "monitor-b", severity: "critical" });

    const merged = mergeIncidentDuplicates([low, critical]);

    expect(merged.severity).toBe(AlertSeverity.CRITICAL);
  });

  it("resolves conflicting title/description by taking the richer (longer) text", () => {
    const terse = record({ id: "a", source: "monitor-a", title: "Paused", description: "Paused." });
    const rich = record({
      id: "b",
      source: "ops-manual",
      title: "Blend USDC vault paused by guardian after oracle anomaly",
      description:
        "Guardian multisig paused the Blend USDC vault after detecting an oracle price anomaly exceeding threshold.",
    });

    const merged = mergeIncidentDuplicates([terse, rich]);

    expect(merged.title).toBe(rich.title);
    expect(merged.description).toBe(rich.description);
  });

  it("unions affectedVaults across sources without duplicates", () => {
    const a = record({ id: "a", source: "monitor-a", affectedVaults: ["Vault1", "Vault2"] });
    const b = record({ id: "b", source: "monitor-b", affectedVaults: ["Vault2", "Vault3"] });

    const merged = mergeIncidentDuplicates([a, b]);

    expect(merged.affectedVaults).toEqual(["Vault1", "Vault2", "Vault3"]);
  });

  it("takes the earliest startedAt across sources", () => {
    const later = record({ id: "a", source: "monitor-a", startedAt: new Date("2026-05-01T00:03:00Z") });
    const earlier = record({ id: "b", source: "monitor-b", startedAt: new Date("2026-05-01T00:00:30Z") });

    const merged = mergeIncidentDuplicates([later, earlier]);

    expect(merged.startedAt).toEqual(earlier.startedAt);
  });

  it("marks resolved=true if ANY source reports resolution, using the earliest resolvedAt", () => {
    const unresolved = record({ id: "a", source: "monitor-a", resolved: false, resolvedAt: null });
    const resolved = record({
      id: "b",
      source: "ops-manual",
      resolved: true,
      resolvedAt: new Date("2026-05-01T01:00:00Z"),
    });

    const merged = mergeIncidentDuplicates([unresolved, resolved]);

    expect(merged.resolved).toBe(true);
    expect(merged.resolvedAt).toEqual(resolved.resolvedAt);
  });

  it("picks the earliest resolvedAt when multiple sources report resolution at different times", () => {
    const resolvedLate = record({
      id: "a",
      source: "monitor-a",
      resolved: true,
      resolvedAt: new Date("2026-05-01T02:00:00Z"),
    });
    const resolvedEarly = record({
      id: "b",
      source: "ops-manual",
      resolved: true,
      resolvedAt: new Date("2026-05-01T01:00:00Z"),
    });

    const merged = mergeIncidentDuplicates([resolvedLate, resolvedEarly]);

    expect(merged.resolvedAt).toEqual(resolvedEarly.resolvedAt);
  });

  it("leaves resolvedAt null when no source reports resolution", () => {
    const a = record({ id: "a", source: "monitor-a", resolved: false });
    const b = record({ id: "b", source: "monitor-b", resolved: false });

    const merged = mergeIncidentDuplicates([a, b]);

    expect(merged.resolved).toBe(false);
    expect(merged.resolvedAt).toBeNull();
  });

  it("takes the first non-null postmortemUrl found", () => {
    const a = record({ id: "a", source: "monitor-a", postmortemUrl: null });
    const b = record({ id: "b", source: "ops-manual", postmortemUrl: "docs/postmortems/2026-05-01-blend.md" });

    const merged = mergeIncidentDuplicates([a, b]);

    expect(merged.postmortemUrl).toBe("docs/postmortems/2026-05-01-blend.md");
  });

  it("handles a single (non-duplicate) record as a trivial merge", () => {
    const only = record({ id: "solo" });
    const merged = mergeIncidentDuplicates([only]);

    expect(merged.sources).toEqual(["on-chain-monitor"]);
    expect(merged.title).toBe(only.title);
    expect(merged.mergedFrom).toEqual([only]);
  });

  it("throws when given an empty array", () => {
    expect(() => mergeIncidentDuplicates([])).toThrow();
  });

  it("throws when records belong to different duplicate groups", () => {
    const a = record({ id: "a", protocol: "Blend" });
    const b = record({ id: "b", protocol: "Soroswap" });

    expect(() => mergeIncidentDuplicates([a, b])).toThrow();
  });
});

describe("buildMergedIncidentTimeline", () => {
  it("renders duplicate incidents once with combined metadata", () => {
    const records: IncidentTimelineRecord[] = [
      record({ id: "a", source: "on-chain-monitor" }),
      record({ id: "b", source: "ops-manual" }),
    ];

    const timeline = buildMergedIncidentTimeline(records);

    expect(timeline).toHaveLength(1);
    expect(timeline[0].sources).toContain("on-chain-monitor");
    expect(timeline[0].sources).toContain("ops-manual");
  });

  it("keeps genuinely distinct incidents (different protocol) as separate entries", () => {
    const records: IncidentTimelineRecord[] = [
      record({ id: "a", protocol: "Blend" }),
      record({ id: "b", protocol: "Soroswap" }),
    ];

    const timeline = buildMergedIncidentTimeline(records);

    expect(timeline).toHaveLength(2);
  });

  it("keeps incidents further apart than the duplicate window as separate entries", () => {
    const records: IncidentTimelineRecord[] = [
      record({ id: "a", startedAt: new Date("2026-05-01T00:00:00Z") }),
      record({ id: "b", startedAt: new Date("2026-05-01T01:00:00Z") }), // 1hr later, outside default 5-min window
    ];

    const timeline = buildMergedIncidentTimeline(records);

    expect(timeline).toHaveLength(2);
  });

  it("handles a mix of duplicate, partial-overlap, and conflicting incidents", () => {
    const records: IncidentTimelineRecord[] = [
      // Group 1: exact duplicate from two sources, conflicting severity.
      record({ id: "a1", source: "monitor-a", protocol: "Blend", severity: "MEDIUM", startedAt: new Date("2026-05-01T00:00:00Z") }),
      record({ id: "a2", source: "ops-manual", protocol: "Blend", severity: "CRITICAL", startedAt: new Date("2026-05-01T00:01:00Z") }),
      // Group 2: single-source incident, different protocol.
      record({ id: "b1", source: "monitor-b", protocol: "Soroswap", startedAt: new Date("2026-05-01T00:00:00Z") }),
      // Group 3: same protocol as group 1 but far apart in time -> distinct incident.
      record({ id: "c1", source: "monitor-a", protocol: "Blend", startedAt: new Date("2026-05-02T00:00:00Z") }),
    ];

    const timeline = buildMergedIncidentTimeline(records);

    expect(timeline).toHaveLength(3);
    const group1 = timeline.find((entry) => entry.mergedFrom.some((r) => r.id === "a1"));
    expect(group1?.severity).toBe(AlertSeverity.CRITICAL);
    expect(group1?.sources).toHaveLength(2);
  });

  it("sorts merged entries newest-first by startedAt", () => {
    const records: IncidentTimelineRecord[] = [
      record({ id: "old", protocol: "Blend", startedAt: new Date("2026-01-01T00:00:00Z") }),
      record({ id: "new", protocol: "Soroswap", startedAt: new Date("2026-06-01T00:00:00Z") }),
    ];

    const timeline = buildMergedIncidentTimeline(records);

    expect(timeline[0].mergedFrom[0].id).toBe("new");
    expect(timeline[1].mergedFrom[0].id).toBe("old");
  });

  it("returns an empty array for an empty input", () => {
    expect(buildMergedIncidentTimeline([])).toEqual([]);
  });

  it("respects a custom duplicate window", () => {
    const records: IncidentTimelineRecord[] = [
      record({ id: "a", startedAt: new Date("2026-05-01T00:00:00Z") }),
      record({ id: "b", startedAt: new Date("2026-05-01T00:10:00Z") }), // 10 min apart
    ];

    // Default 5-min window: treated as distinct.
    expect(buildMergedIncidentTimeline(records)).toHaveLength(2);

    // Wider 15-min window: treated as duplicates.
    expect(buildMergedIncidentTimeline(records, 15 * 60 * 1000)).toHaveLength(1);
  });

  it("uses the documented default window constant", () => {
    expect(DEFAULT_DUPLICATE_WINDOW_MS).toBe(5 * 60 * 1000);
  });
});
