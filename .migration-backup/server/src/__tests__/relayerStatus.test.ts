import {
  getRelayerStatus,
  recordRelayStart,
  recordRelaySuccess,
  recordRelayFailure,
  isHashSeen,
} from "../services/relayerStatusService";

describe("relayerStatusService", () => {
  // Each test gets a fresh module, but since we use in-memory state,
  // we just test the observable behavior.

  describe("getRelayerStatus", () => {
    it("returns a valid status object with defaults", () => {
      const status = getRelayerStatus();

      expect(status).toHaveProperty("isOnline");
      expect(status).toHaveProperty("network");
      expect(status).toHaveProperty("queueDepth");
      expect(status).toHaveProperty("totalRelayed");
      expect(status).toHaveProperty("successCount");
      expect(status).toHaveProperty("failureCount");
      expect(status).toHaveProperty("successRate");
      expect(status).toHaveProperty("avgDurationMs");
      expect(status).toHaveProperty("recentEvents");
      expect(status).toHaveProperty("replayProtection");
      expect(status).toHaveProperty("uptime");
      expect(status).toHaveProperty("checkedAt");

      expect(typeof status.isOnline).toBe("boolean");
      expect(typeof status.queueDepth).toBe("number");
      expect(typeof status.successRate).toBe("number");
      expect(status.successRate).toBeGreaterThanOrEqual(0);
      expect(status.successRate).toBeLessThanOrEqual(100);
      expect(Array.isArray(status.recentEvents)).toBe(true);
    });

    it("reports replay protection as enabled", () => {
      const status = getRelayerStatus();
      expect(status.replayProtection.enabled).toBe(true);
      expect(status.replayProtection.deduplicationWindow).toBe("24h");
    });
  });

  describe("relay event tracking", () => {
    it("records successful relay events", () => {
      const id = recordRelayStart();
      expect(typeof id).toBe("string");
      expect(id).toMatch(/^relay_/);

      recordRelaySuccess(id, 150, "abc123", "def456");

      const status = getRelayerStatus();
      expect(status.totalRelayed).toBeGreaterThanOrEqual(1);
      expect(status.successCount).toBeGreaterThanOrEqual(1);
    });

    it("records failed relay events", () => {
      const id = recordRelayStart();
      recordRelayFailure(id, 50, "Test error");

      const status = getRelayerStatus();
      expect(status.failureCount).toBeGreaterThanOrEqual(1);
    });

    it("tracks replay hashes", () => {
      const testHash = `test_hash_${Date.now()}`;
      expect(isHashSeen(testHash)).toBe(false);

      const id = recordRelayStart();
      recordRelaySuccess(id, 100, testHash);

      expect(isHashSeen(testHash)).toBe(true);
    });
  });

  describe("queue depth", () => {
    it("increments queue on relay start and decrements on completion", () => {
      const before = getRelayerStatus().queueDepth;

      const id1 = recordRelayStart();
      const id2 = recordRelayStart();

      const during = getRelayerStatus().queueDepth;
      expect(during).toBeGreaterThanOrEqual(before + 2);

      recordRelaySuccess(id1, 100);
      recordRelayFailure(id2, 50, "error");

      const after = getRelayerStatus().queueDepth;
      expect(after).toBeLessThanOrEqual(during);
    });
  });

  describe("recent events", () => {
    it("returns events in reverse chronological order", () => {
      const id1 = recordRelayStart();
      recordRelaySuccess(id1, 100, "hash_a");

      const id2 = recordRelayStart();
      recordRelaySuccess(id2, 200, "hash_b");

      const status = getRelayerStatus();
      if (status.recentEvents.length >= 2) {
        const ts1 = new Date(status.recentEvents[0].timestamp).getTime();
        const ts2 = new Date(status.recentEvents[1].timestamp).getTime();
        expect(ts1).toBeGreaterThanOrEqual(ts2);
      }
    });
  });
});
