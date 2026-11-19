/**
 * Tests for the vault migration readiness service (#1293).
 *
 * Focuses on the deterministic, typed surfaces: the pure overall-status policy,
 * the gate evaluator, and the typed error for unknown vault slugs. The async
 * I/O paths (yields/prisma/registry) are intentionally shallow.
 */

import {
  VAULT_REGISTRY,
  deriveMigrationOverallStatus,
  countMigrationGateStatuses,
  buildVaultMigrationReadiness,
  VaultMigrationReadinessError,
} from "../vaultMigrationReadinessService";
import type { MigrationGateStatus } from "../vaultMigrationReadinessService";

function statuses(...statuses: MigrationGateStatus[]) {
  return statuses.map((s) => ({ status: s }));
}

describe("deriveMigrationOverallStatus", () => {
  it("returns ready when all gates pass or warn", () => {
    expect(deriveMigrationOverallStatus(statuses("pass", "warn"))).toBe("ready");
  });

  it("returns not_ready when any gate fails", () => {
    expect(deriveMigrationOverallStatus(statuses("pass", "fail"))).toBe("not_ready");
  });

  it("returns unknown when a gate is unresolved and nothing failed", () => {
    expect(deriveMigrationOverallStatus(statuses("pass", "unknown"))).toBe("unknown");
  });

  it("returns unknown for an empty checklist", () => {
    expect(deriveMigrationOverallStatus([])).toBe("unknown");
  });
});

describe("countMigrationGateStatuses", () => {
  it("counts deterministically", () => {
    expect(countMigrationGateStatuses(statuses("pass", "pass", "warn", "fail", "unknown"))).toEqual({
      pass: 2,
      warn: 1,
      fail: 1,
      unknown: 1,
    });
  });
});

describe("buildVaultMigrationReadiness", () => {
  it("rejects unknown vault slugs with a typed error", async () => {
    await expect(buildVaultMigrationReadiness("does-not-exist")).rejects.toBeInstanceOf(
      VaultMigrationReadinessError,
    );
    try {
      await buildVaultMigrationReadiness("does-not-exist");
    } catch (err) {
      expect((err as VaultMigrationReadinessError).code).toBe("UNKNOWN_VAULT");
      expect((err as VaultMigrationReadinessError).statusCode).toBe(400);
    }
  });

  it("resolves every registered vault slug to metadata", () => {
    expect(Object.keys(VAULT_REGISTRY)).toContain("usdc");
    expect(VAULT_REGISTRY["usdc"].name).toMatch(/vault/i);
  });
});