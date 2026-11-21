import { failoverIncidentHistoryService, ConcurrencyConflictError } from "../../services/failoverIncidentHistoryService";

beforeEach(() => {
  failoverIncidentHistoryService.reset();
});

describe("failoverIncidentHistoryService", () => {
  describe("recordIncident", () => {
    it("creates an incident with the correct fields", () => {
      const incident = failoverIncidentHistoryService.recordIncident({
        protocolId: "blend",
        protocolName: "Blend",
        reasons: ["data is stale (age=360000ms > maxDataAgeMs=300000ms)"],
      });

      expect(incident.protocolId).toBe("blend");
      expect(incident.protocolName).toBe("Blend");
      expect(incident.trigger).toBe("stale_data");
      expect(incident.resolved).toBe(false);
      expect(incident.recoveredAt).toBeUndefined();
      expect(incident.id).toBeDefined();
    });

    it("classifies outage trigger from reasons", () => {
      const incident = failoverIncidentHistoryService.recordIncident({
        protocolId: "soroswap",
        protocolName: "Soroswap",
        reasons: ["status=down"],
      });
      expect(incident.trigger).toBe("outage");
    });

    it("classifies degraded trigger from uptime reasons", () => {
      const incident = failoverIncidentHistoryService.recordIncident({
        protocolId: "defindex",
        protocolName: "DeFindex",
        reasons: ["uptime=0.90 < minUptimeRatio=0.95"],
      });
      expect(incident.trigger).toBe("degraded");
    });

    it("accepts a custom startedAt timestamp", () => {
      const ts = "2026-01-01T00:00:00.000Z";
      const incident = failoverIncidentHistoryService.recordIncident({
        protocolId: "blend",
        protocolName: "Blend",
        reasons: ["status=down"],
        startedAt: ts,
      });
      expect(incident.startedAt).toBe(ts);
    });
  });

  describe("resolveIncident", () => {
    it("marks the open incident as resolved and sets durationMs", () => {
      const startedAt = "2026-01-01T00:00:00.000Z";
      const recoveredAt = "2026-01-01T00:05:00.000Z";

      failoverIncidentHistoryService.recordIncident({
        protocolId: "blend",
        protocolName: "Blend",
        reasons: ["status=down"],
        startedAt,
      });

      const resolved = failoverIncidentHistoryService.resolveIncident("blend", recoveredAt);

      expect(resolved).not.toBeNull();
      expect(resolved!.resolved).toBe(true);
      expect(resolved!.recoveredAt).toBe(recoveredAt);
      expect(resolved!.durationMs).toBe(5 * 60 * 1000); // 5 minutes
    });

    it("returns null when there is no open incident for the protocol", () => {
      const result = failoverIncidentHistoryService.resolveIncident("nonexistent");
      expect(result).toBeNull();
    });

    it("does not resolve an already-resolved incident", () => {
      failoverIncidentHistoryService.recordIncident({
        protocolId: "blend",
        protocolName: "Blend",
        reasons: ["status=down"],
      });
      failoverIncidentHistoryService.resolveIncident("blend");
      const second = failoverIncidentHistoryService.resolveIncident("blend");
      expect(second).toBeNull();
    });
  });

  describe("optimistic concurrency", () => {
    it("increments version on a successful resolve", () => {
      failoverIncidentHistoryService.recordIncident({
        protocolId: "blend",
        protocolName: "Blend",
        reasons: ["status=down"],
      });
      const first = failoverIncidentHistoryService.getHistory("blend")[0];
      expect(first.version).toBe(1);

      const resolved = failoverIncidentHistoryService.resolveIncident("blend");
      expect(resolved!.version).toBe(2);
      expect(resolved!.resolved).toBe(true);

      const stored = failoverIncidentHistoryService.getHistory("blend")[0];
      expect(stored.version).toBe(2);
    });

    it("rejects a resolve with a stale expected version and preserves existing state", () => {
      failoverIncidentHistoryService.recordIncident({
        protocolId: "blend",
        protocolName: "Blend",
        reasons: ["status=down"],
      });
      const incident = failoverIncidentHistoryService.getHistory("blend")[0];
      expect(incident.version).toBe(1);

      // First caller resolves successfully at v1.
      failoverIncidentHistoryService.resolveIncident("blend", "2026-01-01T00:05:00.000Z", 1);

      // A concurrent caller that still holds the stale v1 view conflicts.
      expect(() =>
        failoverIncidentHistoryService.resolveIncident("blend", "2026-01-01T00:05:00.000Z", 1),
      ).toThrow(ConcurrencyConflictError);

      // Existing state is preserved: still resolved once, version advanced to 2.
      const stored = failoverIncidentHistoryService.getHistory("blend")[0];
      expect(stored.resolved).toBe(true);
      expect(stored.version).toBe(2);
    });

    it("accepts a resolve when the expected version matches the current state", () => {
      failoverIncidentHistoryService.recordIncident({
        protocolId: "soroswap",
        protocolName: "Soroswap",
        reasons: ["status=down"],
      });
      const incident = failoverIncidentHistoryService.getHistory("soroswap")[0];

      const resolved = failoverIncidentHistoryService.resolveIncident(
        "soroswap",
        "2026-01-01T00:05:00.000Z",
        incident.version,
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.version).toBe(2);
    });

    it("allows a safe idempotent retry with the same recovery timestamp after resolution", () => {
      failoverIncidentHistoryService.recordIncident({
        protocolId: "blend",
        protocolName: "Blend",
        reasons: ["status=down"],
      });
      const recoveredAt = "2026-01-01T00:05:00.000Z";

      const first = failoverIncidentHistoryService.resolveIncident("blend", recoveredAt, 1);
      const retry = failoverIncidentHistoryService.resolveIncident("blend", recoveredAt, 2);

      expect(first).not.toBeNull();
      expect(retry).not.toBeNull();
      expect(retry!.id).toBe(first!.id);
      expect(retry!.resolved).toBe(true);
      expect(failoverIncidentHistoryService.getHistory("blend")).toHaveLength(1);
    });

    it("does not mutate state when the concurrency check fails before validation of recovery time", () => {
      failoverIncidentHistoryService.recordIncident({
        protocolId: "blend",
        protocolName: "Blend",
        reasons: ["status=down"],
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      const incident = failoverIncidentHistoryService.getHistory("blend")[0];

      // Stale version AND a recovery time that predates the start. The concurrency
      // conflict must be reported first, and nothing is mutated.
      expect(() =>
        failoverIncidentHistoryService.resolveIncident("blend", "2025-12-31T23:59:00.000Z", 1),
      ).toThrow(ConcurrencyConflictError);

      const stored = failoverIncidentHistoryService.getHistory("blend")[0];
      expect(stored.resolved).toBe(false);
      expect(stored.version).toBe(1);
    });
  });

  describe("getHistory", () => {
    it("returns empty array when no incidents exist", () => {
      expect(failoverIncidentHistoryService.getHistory()).toEqual([]);
    });

    it("returns incidents newest first", () => {
      failoverIncidentHistoryService.recordIncident({
        protocolId: "blend",
        protocolName: "Blend",
        reasons: ["status=down"],
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      failoverIncidentHistoryService.recordIncident({
        protocolId: "soroswap",
        protocolName: "Soroswap",
        reasons: ["status=down"],
        startedAt: "2026-01-02T00:00:00.000Z",
      });

      const history = failoverIncidentHistoryService.getHistory();
      expect(history[0].protocolId).toBe("soroswap");
      expect(history[1].protocolId).toBe("blend");
    });

    it("filters by protocolId when provided", () => {
      failoverIncidentHistoryService.recordIncident({
        protocolId: "blend",
        protocolName: "Blend",
        reasons: ["status=down"],
      });
      failoverIncidentHistoryService.recordIncident({
        protocolId: "soroswap",
        protocolName: "Soroswap",
        reasons: ["status=down"],
      });

      const history = failoverIncidentHistoryService.getHistory("blend");
      expect(history).toHaveLength(1);
      expect(history[0].protocolId).toBe("blend");
    });
  });
});
