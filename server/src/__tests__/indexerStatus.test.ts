import request from "supertest";
import { createApp } from "../app";
import {
  classifyIndexerStatus,
  INDEXER_THRESHOLDS,
  type IndexerStatusInput,
} from "../indexer/indexerStatus";

const baseInput: IndexerStatusInput = {
  indexedLedger: 1000,
  horizonLedger: 1005,
  lastIndexedAt: new Date().toISOString(),
  recentErrors: [],
  now: Date.now(),
};

describe("classifyIndexerStatus", () => {
  it("reports healthy when lag is small and there are no errors", () => {
    const status = classifyIndexerStatus(baseInput);
    expect(status.status).toBe("healthy");
    expect(status.lagLedgers).toBe(5);
    expect(status.reason).toBeNull();
  });

  it("marks the indexer degraded once lag exceeds the threshold", () => {
    const status = classifyIndexerStatus({
      ...baseInput,
      horizonLedger: baseInput.indexedLedger! + INDEXER_THRESHOLDS.degradedLagLedgers,
    });
    expect(status.status).toBe("degraded");
    expect(status.reason).toMatch(/lag/i);
  });

  it("marks the indexer unavailable when far behind the network", () => {
    const status = classifyIndexerStatus({
      ...baseInput,
      horizonLedger:
        baseInput.indexedLedger! + INDEXER_THRESHOLDS.unavailableLagLedgers,
    });
    expect(status.status).toBe("unavailable");
  });

  it("is unavailable when no checkpoint exists", () => {
    const status = classifyIndexerStatus({
      ...baseInput,
      indexedLedger: null,
      horizonLedger: null,
    });
    expect(status.status).toBe("unavailable");
    expect(status.lagLedgers).toBeNull();
    expect(status.reason).toMatch(/checkpoint unavailable/i);
  });

  it("degrades on a stale heartbeat even when lag is small", () => {
    const status = classifyIndexerStatus({
      ...baseInput,
      lastIndexedAt: new Date(
        Date.now() - (INDEXER_THRESHOLDS.staleHeartbeatSeconds + 60) * 1000,
      ).toISOString(),
    });
    expect(status.status).toBe("degraded");
    expect(status.heartbeatAgeSeconds).toBeGreaterThan(
      INDEXER_THRESHOLDS.staleHeartbeatSeconds,
    );
  });

  it("degrades when recent replay errors are present", () => {
    const status = classifyIndexerStatus({
      ...baseInput,
      recentErrors: [{ ledger: 1001, message: "boom", at: new Date().toISOString() }],
    });
    expect(status.status).toBe("degraded");
    expect(status.reason).toMatch(/replay error/i);
  });
});

describe("GET /api/indexer/status", () => {
  it("returns 200 with a well-formed status envelope", async () => {
    const res = await request(createApp()).get("/api/indexer/status");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { data } = res.body;
    expect(["healthy", "degraded", "unavailable"]).toContain(data.status);
    expect("indexedLedger" in data).toBe(true);
    expect("lagLedgers" in data).toBe(true);
    expect(Array.isArray(data.recentErrors)).toBe(true);
    expect(typeof data.generatedAt).toBe("string");
  });
});
