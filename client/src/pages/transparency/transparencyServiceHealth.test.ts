import { describe, it, expect } from "vitest";
import {
  assessRegistryFromRecords,
  MIN_KNOWN_SUBSYSTEMS,
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
import { areDiagnosticsPrivacySafe } from "../../../../shared/types/transparencyDiagnostic";

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

describe("summarizeTransparencyHealth – insufficient diagnostic context (#1917)", () => {
  const healthyInput = {
    indexer: "healthy" as const,
    relayer: "healthy" as const,
    registry: "healthy" as const,
    smokeTest: "healthy" as const,
  };

  it("reports sufficient context and no diagnostics during normal operation", () => {
    const summary = summarizeTransparencyHealth(healthyInput);

    expect(summary.overall).toBe("healthy");
    expect(summary.contextSufficient).toBe(true);
    expect(summary.reusedSubsystems).toEqual([]);
    expect(summary.diagnostics).toEqual([]);
  });

  it("flags insufficient context instead of claiming healthy", () => {
    const summary = summarizeTransparencyHealth({ indexer: "healthy" });

    expect(summary.contextSufficient).toBe(false);
    expect(summary.overall).toBe("degraded");
    expect(summary.summaryMessage).toMatch(/insufficient diagnostic context/i);
    expect(summary.summaryMessage).toMatch(/Degraded/);

    const [diagnostic] = summary.diagnostics.filter(
      (entry) => entry.code === "CONTEXT_INSUFFICIENT",
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic.stage).toBe("context-validation");
    expect(diagnostic.retryable).toBe(true);
    expect(diagnostic.privacySafe).toBe(true);
    expect(diagnostic.remediation.length).toBeGreaterThan(0);
    expect(areDiagnosticsPrivacySafe(summary.diagnostics)).toBe(true);
  });

  it("names the failed stage and severity when a subsystem fails", () => {
    const summary = summarizeTransparencyHealth({
      ...healthyInput,
      relayer: "failed",
    });

    expect(summary.overall).toBe("failed");
    const diagnostic = summary.diagnostics.find((entry) => entry.severity === "critical");
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.code).toBe("SUBSYSTEM_UNAVAILABLE");
    expect(diagnostic?.stage).toBe("relayer");
    expect(diagnostic?.affectedStages).toEqual(["relayer"]);
    expect(areDiagnosticsPrivacySafe(summary.diagnostics)).toBe(true);
  });

  it("preserves last known-good signals on a safe retry with missing context", () => {
    const first = summarizeTransparencyHealth(healthyInput);
    const retried = summarizeTransparencyHealth({}, first.subsystems);

    expect(retried.subsystems).toEqual(healthyInput);
    expect(retried.reusedSubsystems).toHaveLength(4);
    expect(retried.contextSufficient).toBe(true);
    expect(retried.overall).toBe("healthy");

    const stale = retried.diagnostics.find((entry) => entry.code === "STALE_LAST_KNOWN");
    expect(stale).toBeDefined();
    expect(stale?.stage).toBe("cache");
    expect(stale?.retryable).toBe(true);
    expect(areDiagnosticsPrivacySafe(retried.diagnostics)).toBe(true);
  });

  it("does not invent previous values that were never observed", () => {
    const retried = summarizeTransparencyHealth({}, { indexer: "unknown" });

    expect(retried.reusedSubsystems).toEqual([]);
    expect(retried.contextSufficient).toBe(false);
    expect(retried.subsystems.indexer).toBe("unknown");
    expect(MIN_KNOWN_SUBSYSTEMS).toBeGreaterThan(1);
  });
});

describe("validateTransparencySummaryPayload – status and diagnostics (#1917)", () => {
  const base = {
    totalRevenueLumens: 100,
    totalBurnedTokens: 50,
    deflationaryRatio: 20,
    history: [{ date: "2026-04-01", revenue: 100, burned: 50 }],
  };

  it("passes through a known status and well-formed privacy-safe diagnostics", () => {
    const diagnostic = {
      code: "AGGREGATION_FAILED",
      stage: "aggregation",
      severity: "warning",
      summary: "Metric aggregation did not complete.",
      remediation: "Retry shortly.",
      retryable: true,
      privacySafe: true,
      affectedStages: ["aggregation", "not-a-stage"],
    };
    const result = validateTransparencySummaryPayload({
      ...base,
      status: "degraded",
      diagnostics: [diagnostic],
    });

    expect(result.status).toBe("degraded");
    expect(result.diagnostics).toEqual([{ ...diagnostic, affectedStages: ["aggregation"] }]);
  });

  it("drops unknown statuses and malformed or unsafe diagnostics", () => {
    const result = validateTransparencySummaryPayload({
      ...base,
      status: "totally-fine",
      diagnostics: [
        null,
        { code: "AGGREGATION_FAILED", stage: "aggregation", severity: "warning" },
        {
          code: "NOT_A_CODE",
          stage: "aggregation",
          severity: "warning",
          summary: "x",
          remediation: "y",
          retryable: true,
          privacySafe: true,
        },
        {
          code: "AGGREGATION_FAILED",
          stage: "aggregation",
          severity: "warning",
          summary: "x",
          remediation: "y",
          retryable: true,
          privacySafe: false,
        },
      ],
    });

    expect(result.status).toBeUndefined();
    expect(result.diagnostics).toBeUndefined();
    expect(result).toEqual(base);
  });
});

describe("summarizeTransparencyHealth – stale configuration snapshots (#1910)", () => {
  const healthyInput = {
    indexer: "healthy" as const,
    relayer: "healthy" as const,
    registry: "healthy" as const,
    smokeTest: "healthy" as const,
  };

  it("reports healthy with no stale signal when the configuration is unchanged", () => {
    const first = summarizeTransparencyHealth(healthyInput, undefined, {
      configFingerprint: "cfg1:aaaaaaaaaaaaaaaa",
    });
    expect(first.overall).toBe("healthy");
    expect(first.configStale).toBe(false);
    expect(first.diagnostics).toEqual([]);

    const retried = summarizeTransparencyHealth({}, first.subsystems, {
      configFingerprint: "cfg1:aaaaaaaaaaaaaaaa",
      previousConfigFingerprint: first.configFingerprint,
    });

    // Unchanged configuration: last known-good signals are safely reusable.
    expect(retried.configStale).toBe(false);
    expect(retried.subsystems).toEqual(healthyInput);
    expect(retried.reusedSubsystems).toHaveLength(4);
    expect(retried.overall).toBe("healthy");
  });

  it("rejects signals from a previous configuration and never reports healthy", () => {
    const first = summarizeTransparencyHealth(healthyInput, undefined, {
      configFingerprint: "cfg1:aaaaaaaaaaaaaaaa",
    });

    const afterChange = summarizeTransparencyHealth({}, first.subsystems, {
      configFingerprint: "cfg1:bbbbbbbbbbbbbbbb",
      previousConfigFingerprint: first.configFingerprint,
    });

    expect(afterChange.configStale).toBe(true);
    expect(afterChange.reusedSubsystems).toEqual([]);
    expect(afterChange.subsystems).toEqual({
      indexer: "unknown",
      relayer: "unknown",
      registry: "unknown",
      smokeTest: "unknown",
    });
    expect(afterChange.contextSufficient).toBe(false);
    expect(afterChange.overall).toBe("degraded");
    expect(afterChange.summaryMessage).toMatch(/configuration changed/i);

    const stale = afterChange.diagnostics.find(
      (entry) => entry.code === "CONFIG_SNAPSHOT_STALE",
    );
    expect(stale).toBeDefined();
    expect(stale?.stage).toBe("configuration");
    expect(stale?.severity).toBe("critical");
    expect(stale?.retryable).toBe(true);
    expect(areDiagnosticsPrivacySafe(afterChange.diagnostics)).toBe(true);
  });

  it("keeps fresh signals reported under the new configuration", () => {
    const first = summarizeTransparencyHealth(healthyInput, undefined, {
      configFingerprint: "cfg1:aaaaaaaaaaaaaaaa",
    });

    const afterChange = summarizeTransparencyHealth(
      { indexer: "healthy", relayer: "healthy" },
      first.subsystems,
      {
        configFingerprint: "cfg1:bbbbbbbbbbbbbbbb",
        previousConfigFingerprint: first.configFingerprint,
      },
    );

    // The two fresh signals are kept; the two from the old config are dropped.
    expect(afterChange.subsystems.indexer).toBe("healthy");
    expect(afterChange.subsystems.relayer).toBe("healthy");
    expect(afterChange.subsystems.registry).toBe("unknown");
    expect(afterChange.subsystems.smokeTest).toBe("unknown");
    expect(afterChange.reusedSubsystems).toEqual([]);
    expect(afterChange.configStale).toBe(true);
    expect(afterChange.contextSufficient).toBe(true);
    // The two dropped signals are unknown, so the rollup is degraded rather
    // than healthy even though the fresh signals are healthy.
    expect(afterChange.overall).toBe("degraded");
    expect(afterChange.attentionSubsystems).toEqual(["registry", "smokeTest"]);
  });

  it("treats a missing previous fingerprint as unknown, not as a mismatch", () => {
    const summary = summarizeTransparencyHealth({}, healthyInput, {
      configFingerprint: "cfg1:bbbbbbbbbbbbbbbb",
    });

    expect(summary.configStale).toBe(false);
    expect(summary.reusedSubsystems).toHaveLength(4);
    expect(summary.overall).toBe("healthy");
  });

  it("does not invent values that were never observed after a config change", () => {
    const summary = summarizeTransparencyHealth({}, { indexer: "unknown" }, {
      configFingerprint: "cfg1:bbbbbbbbbbbbbbbb",
      previousConfigFingerprint: "cfg1:aaaaaaaaaaaaaaaa",
    });

    expect(summary.reusedSubsystems).toEqual([]);
    expect(summary.contextSufficient).toBe(false);
    expect(summary.subsystems.indexer).toBe("unknown");
  });
});
