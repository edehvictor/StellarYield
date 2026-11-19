/**
 * vaultMigrationReadiness.ts
 *
 * Pure, framework-free helpers for deriving a vault migration readiness status
 * from the server checklist. Kept testable without rendering.
 */

import type {
  MigrationGateStatus,
  ReadinessGate,
  MigrationReadinessReport,
} from "../services/migrationReadinessService";

export function deriveOverallStatus(
  gates: Pick<ReadinessGate, "status">[],
): MigrationReadinessReport["overallStatus"] {
  const hasFail = gates.some((g) => g.status === "fail");
  const hasUnknown = gates.some((g) => g.status === "unknown");
  if (hasFail) return "not_ready";
  if (hasUnknown) return "unknown";
  return "ready";
}

export function countGateStatuses(
  gates: Pick<ReadinessGate, "status">[],
): Record<MigrationGateStatus, number> {
  return {
    pass: gates.filter((g) => g.status === "pass").length,
    warn: gates.filter((g) => g.status === "warn").length,
    fail: gates.filter((g) => g.status === "fail").length,
    unknown: gates.filter((g) => g.status === "unknown").length,
  };
}

export const GATE_STATUS_ORDER: MigrationGateStatus[] = [
  "pass",
  "warn",
  "fail",
  "unknown",
];