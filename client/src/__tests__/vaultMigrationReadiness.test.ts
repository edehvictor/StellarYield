import { describe, it, expect } from "vitest";
import {
  deriveOverallStatus,
  countGateStatuses,
  GATE_STATUS_ORDER,
} from "../lib/vaultMigrationReadiness";
import type { ReadinessGate } from "../services/migrationReadinessService";

function gate(status: ReadinessGate["status"]): Pick<ReadinessGate, "status"> {
  return { status };
}

describe("deriveOverallStatus", () => {
  it("returns ready when every gate passes", () => {
    expect(deriveOverallStatus([gate("pass"), gate("pass")])).toBe("ready");
  });

  it("returns ready when only warnings remain", () => {
    expect(deriveOverallStatus([gate("pass"), gate("warn")])).toBe("ready");
  });

  it("returns not_ready when any gate fails", () => {
    expect(deriveOverallStatus([gate("pass"), gate("fail")])).toBe("not_ready");
  });

  it("returns unknown when an edge case is unresolved but nothing failed", () => {
    expect(deriveOverallStatus([gate("pass"), gate("unknown")])).toBe("unknown");
  });

  it("treats an empty checklist as unknown (no evidence)", () => {
    expect(deriveOverallStatus([])).toBe("unknown");
  });
});

describe("countGateStatuses", () => {
  it("counts every gate status deterministically", () => {
    const counts = countGateStatuses([
      gate("pass"),
      gate("pass"),
      gate("warn"),
      gate("fail"),
      gate("unknown"),
    ]);
    expect(counts).toEqual({ pass: 2, warn: 1, fail: 1, unknown: 1 });
  });

  it("returns zeros for an empty checklist", () => {
    expect(countGateStatuses([])).toEqual({ pass: 0, warn: 0, fail: 0, unknown: 0 });
  });

  it("exposes a stable ordering for UI presentation", () => {
    expect(GATE_STATUS_ORDER).toEqual(["pass", "warn", "fail", "unknown"]);
  });
});