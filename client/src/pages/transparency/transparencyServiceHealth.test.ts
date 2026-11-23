import { describe, it, expect } from "vitest";
import {
  assessRegistryFromRecords,
  mapIndexerStatus,
  mapRelayerStatus,
  mapRegistryHealth,
  mapSmokeTestStatus,
  parseIndexerStatusPayload,
  parseRelayerStatusPayload,
  sanitizeSubsystemState,
  summarizeTransparencyHealth,
  TransparencyExternalDataError,
  validateFailoverIncident,
  validateFailoverIncidentsPayload,
  validateTransparencySummaryPayload,
} from "./transparencyServiceHealth";

describe("transparencyServiceHealth mappers", () => {
  it("maps indexer statuses", () => {
    expect(mapIndexerStatus("healthy")).toBe("healthy");
    expect(mapIndexerStatus("degraded")).toBe("degraded");
    expect(mapIndexerStatus("unavailable")).toBe("failed");
    expect(mapIndexerStatus(undefined)).toBe("unknown");
  });

  it("maps relayer mixed success/failure states", () => {
    expect(mapRelayerStatus({ isOnline: true, failureCount: 0, successRate: 100 })).toBe(
      "healthy",
    );
    expect(mapRelayerStatus({ isOnline: true, failureCount: 2, successRate: 80 })).toBe(
      "degraded",
    );
    expect(mapRelayerStatus({ isOnline: true, failureCount: 5, successRate: 40 })).toBe("failed");
    expect(mapRelayerStatus({ isOnline: false, failureCount: 0, successRate: 100 })).toBe(
      "failed",
    );
  });

  it("maps registry diff health", () => {
    expect(mapRegistryHealth({ hasMissing: false, hasRemoved: false, hasChanged: false })).toBe(
      "healthy",
    );
    expect(mapRegistryHealth({ hasMissing: true, hasRemoved: false, hasChanged: false })).toBe(
      "degraded",
    );
    expect(mapRegistryHealth({ hasMissing: false, hasRemoved: true, hasChanged: false })).toBe(
      "failed",
    );
  });

  it("maps smoke-test pass/fail and mixed checks", () => {
    expect(mapSmokeTestStatus("pass")).toBe("healthy");
    expect(mapSmokeTestStatus("fail")).toBe("failed");
    expect(mapSmokeTestStatus(null)).toBe("unknown");
    expect(
      mapSmokeTestStatus("pass", [
        { status: "pass" },
        { status: "fail" },
      ]),
    ).toBe("degraded");
  });
});

describe("boundary-value status hardening (#1914)", () => {
  it("mapRelayerStatus handles zero, minimum and maximum values", () => {
    expect(mapRelayerStatus({ isOnline: true, failureCount: 0, successRate: 100 })).toBe("healthy");
    expect(mapRelayerStatus({ isOnline: true, failureCount: 0, successRate: 50 })).toBe("healthy");
    expect(mapRelayerStatus({ isOnline: true, failureCount: 1, successRate: 50 })).toBe("degraded");
    expect(mapRelayerStatus({ isOnline: true, failureCount: 1, successRate: 49.99 })).toBe("failed");
    expect(mapRelayerStatus({ isOnline: true, failureCount: Number.MAX_SAFE_INTEGER, successRate: 100 })).toBe("degraded");
    expect(mapRelayerStatus({ isOnline: true, failureCount: Number.MAX_SAFE_INTEGER, successRate: 0 })).toBe("failed");
  });

  it("mapRelayerStatus never reports healthy for NaN, Infinity or out-of-range inputs", () => {
    expect(mapRelayerStatus({ isOnline: true, failureCount: NaN, successRate: NaN })).not.toBe("healthy");
    expect(mapRelayerStatus({ isOnline: true, failureCount: Infinity, successRate: 100 })).not.toBe("healthy");
    expect(mapRelayerStatus({ isOnline: true, failureCount: 0, successRate: Infinity })).toBe("degraded");
    expect(mapRelayerStatus({ isOnline: true, failureCount: -5, successRate: 100 })).toBe("degraded");
    expect(mapRelayerStatus({ isOnline: true, failureCount: 0, successRate: 150 })).toBe("degraded");
    expect(mapRelayerStatus({ isOnline: true, failureCount: 0, successRate: -10 })).toBe("degraded");
    expect(mapRelayerStatus({ isOnline: true, failureCount: 5, successRate: NaN })).toBe("failed");
  });

  it("sanitizeSubsystemState coerces invalid values to unknown", () => {
    expect(sanitizeSubsystemState("healthy")).toBe("healthy");
    expect(sanitizeSubsystemState(undefined)).toBe("unknown");
    expect(sanitizeSubsystemState(null)).toBe("unknown");
    expect(sanitizeSubsystemState("HEALTHY")).toBe("unknown");
    expect(sanitizeSubsystemState(0)).toBe("unknown");
    expect(sanitizeSubsystemState("")).toBe("unknown");
  });

  it("summarizeTransparencyHealth never yields healthy from boundary-poisoned input", () => {
    const boundary = summarizeTransparencyHealth({
      indexer: "" as never,
      relayer: "ok" as never,
      registry: undefined,
      smokeTest: "degraded",
    });
    expect(boundary.overall).not.toBe("healthy");
    expect(boundary.subsystems.indexer).toBe("unknown");
    expect(boundary.subsystems.relayer).toBe("unknown");
  });

  it("is idempotent and safe to retry with the same boundary input", () => {
    const input = { indexer: "healthy", relayer: "healthy", registry: "healthy", smokeTest: "healthy" } as const;
    const a = summarizeTransparencyHealth(input);
    const b = summarizeTransparencyHealth(input);
    expect(a).toEqual(b);
    expect(a.overall).toBe("healthy");
  });
});

describe("summarizeTransparencyHealth", () => {
  it("returns healthy when all subsystems are healthy", () => {
    const summary = summarizeTransparencyHealth({
      indexer: "healthy",
      relayer: "healthy",
      registry: "healthy",
      smokeTest: "healthy",
    });

    expect(summary.overall).toBe("healthy");
    expect(summary.needsAttention).toBe(false);
    expect(summary.attentionSubsystems).toEqual([]);
  });

  it("prioritizes failed over degraded subsystems", () => {
    const summary = summarizeTransparencyHealth({
      indexer: "healthy",
      relayer: "failed",
      registry: "degraded",
      smokeTest: "healthy",
    });

    expect(summary.overall).toBe("failed");
    expect(summary.attentionSubsystems[0]).toBe("relayer");
    expect(summary.summaryMessage).toMatch(/Critical/);
  });

  it("treats unknown subsystems as degraded overall", () => {
    const summary = summarizeTransparencyHealth({
      indexer: "healthy",
      relayer: "healthy",
      registry: "healthy",
      smokeTest: "unknown",
    });

    expect(summary.overall).toBe("degraded");
    expect(summary.attentionSubsystems).toEqual(["smokeTest"]);
  });

  it("is deterministic for conflicting mixed states", () => {
    const input = {
      indexer: "degraded" as const,
      relayer: "healthy" as const,
      registry: "failed" as const,
      smokeTest: "healthy" as const,
    };
    const a = summarizeTransparencyHealth(input);
    const b = summarizeTransparencyHealth(input);
    expect(a).toEqual(b);
    expect(a.overall).toBe("failed");
  });

  it("handles partial input with unknown defaults", () => {
    const summary = summarizeTransparencyHealth({ indexer: "healthy" });
    expect(summary.subsystems.relayer).toBe("unknown");
    expect(summary.overall).toBe("degraded");
  });
});

describe("malformed external data hardening (#1913)", () => {
  it("validateTransparencySummaryPayload accepts valid payloads and returns an unmutated clone", () => {
    const raw = {
      totalRevenueLumens: 372000,
      totalBurnedTokens: 96000,
      deflationaryRatio: 32,
      history: [{ date: "2026-04-01", revenue: 12000, burned: 3200 }],
    };
    const snapshot = structuredClone(raw);
    const result = validateTransparencySummaryPayload(raw);

    expect(result).toEqual(raw);
    expect(result).not.toBe(raw);
    expect(result.history[0]).not.toBe(raw.history[0]);
    expect(raw).toEqual(snapshot);
  });

  it("validateTransparencySummaryPayload rejects malformed summary payloads with typed TransparencyExternalDataError without mutating input", () => {
    const malformedCases: unknown[] = [
      null,
      undefined,
      "not-an-object",
      [],
      { totalRevenueLumens: "372000", totalBurnedTokens: 96000, deflationaryRatio: 32, history: [] },
      { totalRevenueLumens: -1, totalBurnedTokens: 96000, deflationaryRatio: 32, history: [] },
      { totalRevenueLumens: 100, totalBurnedTokens: 50, deflationaryRatio: 101, history: [] },
      { totalRevenueLumens: 100, totalBurnedTokens: 50, deflationaryRatio: 20, history: "bad" },
      {
        totalRevenueLumens: 100,
        totalBurnedTokens: 50,
        deflationaryRatio: 20,
        history: [{ date: "not-a-date", revenue: 100, burned: 50 }],
      },
      {
        totalRevenueLumens: 100,
        totalBurnedTokens: 50,
        deflationaryRatio: 20,
        history: [{ date: "2026-02-31", revenue: 100, burned: 50 }],
      },
      {
        totalRevenueLumens: 100,
        totalBurnedTokens: 50,
        deflationaryRatio: 20,
        history: [{ date: "2026-04-01", revenue: "100", burned: 50 }],
      },
    ];

    for (const bad of malformedCases) {
      const before = typeof bad === "object" && bad !== null ? structuredClone(bad) : bad;
      expect(() => validateTransparencySummaryPayload(bad)).toThrow(TransparencyExternalDataError);
      if (typeof bad === "object" && bad !== null) {
        expect(bad).toEqual(before);
      }
    }
  });

  it("validateFailoverIncidentsPayload validates envelopes, filters malformed records, and rejects completely invalid lists", () => {
    const validIncident = {
      id: "1",
      protocolId: "blend",
      protocolName: "Blend",
      trigger: "stale_data",
      reasons: ["data is stale"],
      startedAt: "2026-05-01T10:00:00.000Z",
      resolved: false,
    };

    expect(validateFailoverIncidentsPayload({ incidents: [] })).toEqual([]);
    expect(
      validateFailoverIncidentsPayload({
        incidents: [validIncident, { id: "2", trigger: null, reasons: "bad" }],
      }),
    ).toEqual([validIncident]);

    expect(() => validateFailoverIncidentsPayload(null)).toThrow(TransparencyExternalDataError);
    expect(() => validateFailoverIncidentsPayload({ incidents: "not-an-array" })).toThrow(
      TransparencyExternalDataError,
    );
    expect(() =>
      validateFailoverIncidentsPayload({
        incidents: [{ id: "bad", protocolId: "x", protocolName: "X", trigger: 123 }],
      }),
    ).toThrow(TransparencyExternalDataError);
    expect(validateFailoverIncident({ ...validIncident, durationMs: -5 })).toBeNull();
    expect(validateFailoverIncident({ ...validIncident, recoveredAt: "invalid-date" })).toBeNull();
  });

  it("parseIndexerStatusPayload and parseRelayerStatusPayload safely handle envelopes and malformed fields", () => {
    expect(parseIndexerStatusPayload({ status: "healthy" })).toBe("healthy");
    expect(parseIndexerStatusPayload({ success: true, data: { status: "degraded" } })).toBe(
      "degraded",
    );
    expect(parseIndexerStatusPayload({ success: false, data: { status: "healthy" } })).toBe(
      "unknown",
    );
    expect(parseIndexerStatusPayload(null)).toBe("unknown");
    expect(parseIndexerStatusPayload({ status: 123 })).toBe("unknown");

    expect(
      parseRelayerStatusPayload({ isOnline: true, failureCount: 0, successRate: 100 }),
    ).toBe("healthy");
    // Missing failureCount/successRate or non-boolean isOnline must never default to healthy
    expect(parseRelayerStatusPayload({ isOnline: true })).toBe("degraded");
    expect(
      parseRelayerStatusPayload({
        isOnline: "false" as unknown as boolean,
        failureCount: 0,
        successRate: 100,
      }),
    ).toBe("unknown");
    expect(parseRelayerStatusPayload(null)).toBe("unknown");
    expect(mapRelayerStatus(null as never)).toBe("unknown");
  });

  it("assessRegistryFromRecords, mapRegistryHealth, and mapSmokeTestStatus reject malformed inputs safely", () => {
    expect(assessRegistryFromRecords(null as never, {} as never)).toBe("unknown");
    expect(
      assessRegistryFromRecords(
        {
          _comment: "metadata comment" as unknown as Record<string, string>,
          testnet: { vault: "GABC" },
        },
        {
          _comment: "older comment" as unknown as Record<string, string>,
          testnet: { vault: "GABC" },
        },
      ),
    ).toBe("healthy");
    expect(
      assessRegistryFromRecords(
        { testnet: { vault: 123 as unknown as string } },
        { testnet: { vault: "GABC" } },
      ),
    ).toBe("unknown");
    expect(mapRegistryHealth(null as never)).toBe("unknown");
    expect(mapSmokeTestStatus("invalid" as never)).toBe("unknown");
    expect(mapSmokeTestStatus("pass", [{ status: "corrupt" as never }])).toBe("unknown");
    expect(summarizeTransparencyHealth(null as never).overall).toBe("degraded");
  });
});
