import type { ReallocationPlanInput } from "../../services/reallocationTimelinePlannerService";

/**
 * Deterministic fixtures for reallocation timeline planner checks (#870).
 *
 * Every fixture pins explicit timestamps and recovery windows so assertions
 * are stable across CI runs. No Math.random or runtime timestamps here.
 */

export const FIXED_PLAN_TIME = "2026-05-01T00:00:00.000Z";

export function stepAt(
  scheduledAt: string,
  expectedRecoveryHours: number,
  overrides: Partial<{ expectedFeeUsd: number; allocations: Record<string, number> }> = {},
) {
  return {
    scheduledAt,
    allocations: { "Vault-A": 70, "Vault-B": 20, "Vault-C": 10 },
    expectedFeeUsd: 200,
    expectedRecoveryHours,
    ...overrides,
  };
}

/** A safe plan: steps staggered well past each recovery window. */
export const SAFE_STAGGERED_PLAN: ReallocationPlanInput = {
  planName: "Safe Staggered",
  sourceVault: "Vault-A",
  destinationVaults: ["Vault-B", "Vault-C"],
  totalCapitalUsd: 500000,
  steps: [
    stepAt("2026-05-01T00:00:00.000Z", 12),
    stepAt("2026-05-01T13:00:00.000Z", 12),
    stepAt("2026-05-02T02:00:00.000Z", 12),
  ],
};

/** Back-to-back: each step starts exactly when the previous window closes. */
export const BACK_TO_BACK_PLAN: ReallocationPlanInput = {
  planName: "Back To Back",
  sourceVault: "Vault-A",
  destinationVaults: ["Vault-B", "Vault-C"],
  totalCapitalUsd: 500000,
  steps: [
    stepAt("2026-05-01T00:00:00.000Z", 12),
    stepAt("2026-05-01T12:00:00.000Z", 12),
  ],
};

/** Overlapping windows: second step starts 6h into the first step's 12h window. */
export const OVERLAPPING_WINDOWS_PLAN: ReallocationPlanInput = {
  planName: "Overlapping Windows",
  sourceVault: "Vault-A",
  destinationVaults: ["Vault-B", "Vault-C"],
  totalCapitalUsd: 500000,
  steps: [
    stepAt("2026-05-01T00:00:00.000Z", 12),
    stepAt("2026-05-01T06:00:00.000Z", 12),
  ],
};

/** Same start time: two steps scheduled simultaneously always overlap. */
export const SAME_START_OVERLAP_PLAN: ReallocationPlanInput = {
  planName: "Same Start Overlap",
  sourceVault: "Vault-A",
  destinationVaults: ["Vault-B", "Vault-C"],
  totalCapitalUsd: 500000,
  steps: [
    stepAt("2026-05-01T00:00:00.000Z", 12),
    stepAt("2026-05-01T00:00:00.000Z", 12),
  ],
};

/** Unsafe sequencing: a step is listed before an earlier-scheduled step. */
export const UNSAFE_SEQUENCE_PLAN: ReallocationPlanInput = {
  planName: "Unsafe Sequence",
  sourceVault: "Vault-A",
  destinationVaults: ["Vault-B", "Vault-C"],
  totalCapitalUsd: 500000,
  steps: [
    stepAt("2026-05-01T12:00:00.000Z", 12),
    stepAt("2026-05-01T00:00:00.000Z", 12),
  ],
};

/** Mixed: an overlapping pair plus an out-of-order step in the same plan. */
export const MIXED_CONFLICT_PLAN: ReallocationPlanInput = {
  planName: "Mixed Conflicts",
  sourceVault: "Vault-A",
  destinationVaults: ["Vault-B", "Vault-C"],
  totalCapitalUsd: 500000,
  steps: [
    stepAt("2026-05-01T00:00:00.000Z", 12),
    stepAt("2026-05-01T06:00:00.000Z", 12),
    stepAt("2026-05-01T04:00:00.000Z", 12),
  ],
};
