import { failoverIncidentHistoryService } from "../../services/failoverIncidentHistoryService";

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
