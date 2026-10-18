/**
 * GET /api/yields — protocol fee history field (#1147).
 *
 * The yield-data cache (NodeCache, 5-minute TTL in yieldService.ts) means a
 * fee snapshot is only (re-)recorded on a genuine cache MISS — so these
 * route-level assertions all derive from a single request in this file, to
 * avoid an inter-test ordering dependency on cache state.
 */
import request from "supertest";
import { createApp } from "../app";
import {
  resetFeeHistory,
  getFeeHistory,
  recordFeeSnapshotIfChanged,
} from "../services/protocolFeeHistoryService";

describe("GET /api/yields — feeHistory", () => {
  const app = createApp();
  let body: Array<{ protocolName: string; feeHistory: unknown[] }>;

  beforeAll(async () => {
    resetFeeHistory();
    const res = await request(app).get("/api/yields");
    expect(res.status).toBe(200);
    body = res.body;
  });

  it("includes a feeHistory array for every yield source", () => {
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const entry of body) {
      expect(Array.isArray(entry.feeHistory)).toBe(true);
    }
  });

  it("records a well-formed snapshot for a known protocol", () => {
    const blendEntry = body.find((e) => e.protocolName === "Blend");
    expect(blendEntry).toBeDefined();
    expect(blendEntry!.feeHistory.length).toBeGreaterThanOrEqual(1);
    expect(blendEntry!.feeHistory[0]).toEqual(
      expect.objectContaining({
        feeBps: expect.any(Number),
        changedAt: expect.any(String),
      }),
    );
  });
});

describe("protocolFeeHistoryService — empty and sorted states", () => {
  beforeEach(() => {
    resetFeeHistory();
  });

  it("renders a clean, stable empty array before any fee snapshot has been recorded", () => {
    expect(getFeeHistory("SomeProtocolNeverConfigured")).toEqual([]);
  });

  it("sorts fee history entries newest-first when multiple snapshots have been recorded", () => {
    recordFeeSnapshotIfChanged("Blend", 1000, "2026-01-01T00:00:00.000Z");
    recordFeeSnapshotIfChanged("Blend", 1200, "2026-01-02T00:00:00.000Z");
    recordFeeSnapshotIfChanged("Blend", 900, "2026-01-03T00:00:00.000Z");

    const history = getFeeHistory("Blend");
    const timestamps = history.map((h) => new Date(h.changedAt).getTime());
    const sorted = [...timestamps].sort((a, b) => b - a);
    expect(timestamps).toEqual(sorted);
    expect(history[0].feeBps).toBe(900);
  });
});
