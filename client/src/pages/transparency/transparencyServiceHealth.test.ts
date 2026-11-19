import { describe, it, expect } from "vitest";
import {
  mapIndexerStatus,
  mapRelayerStatus,
  mapRegistryHealth,
  mapSmokeTestStatus,
  sanitizeSubsystemState,
  summarizeTransparencyHealth,
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
