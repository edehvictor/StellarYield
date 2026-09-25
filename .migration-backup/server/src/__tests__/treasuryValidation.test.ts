import { assertValidScenarioInput, TreasuryValidationError } from "../services/treasurySimulationService";
import { TARGET_ALLOCATIONS } from "../config/targetAllocations";

const baseAlloc = (overrides: any = {}) => ({
  vaultId: overrides.vaultId ?? "Blend",
  vaultName: overrides.vaultName ?? "Blend",
  allocationPct: overrides.allocationPct ?? 100,
  apy: 5,
  tvlUsd: 1_000_000,
  riskScore: 5,
  rotationCostPct: 0.1,
});

function makeBody(allocs: any[]) {
  return {
    id: `t-${Date.now()}`,
    name: "t",
    totalCapitalUsd: 1000,
    allocations: allocs,
  };
}

describe("allocation validation - server", () => {
  it("rejects negative allocationPct", () => {
    const b = makeBody([baseAlloc({ allocationPct: -10 })]);
    expect(() => assertValidScenarioInput(b)).toThrow(TreasuryValidationError);
    try {
      assertValidScenarioInput(b);
    } catch (e: any) {
      expect(e.details).toBeDefined();
      expect(e.details.fieldErrors.some((f: any) => f.code === 'negative')).toBe(true);
    }
  });

  it("rejects dust non-zero allocationPct values", () => {
    const b = makeBody([baseAlloc({ allocationPct: 0.005 }), baseAlloc({ vaultId: 'Soroswap', allocationPct: 99.995 })]);
    expect(() => assertValidScenarioInput(b)).toThrow(TreasuryValidationError);
    try {
      assertValidScenarioInput(b);
    } catch (e: any) {
      expect(e.details.fieldErrors.some((f: any) => f.code === 'dust')).toBe(true);
    }
  });

  it("rejects allocations that do not sum to ~100 (beyond tolerance)", () => {
    const b = makeBody([baseAlloc({ allocationPct: 30 }), baseAlloc({ vaultId: 'Soroswap', allocationPct: 30 })]);
    expect(() => assertValidScenarioInput(b)).toThrow(TreasuryValidationError);
    try {
      assertValidScenarioInput(b);
    } catch (e: any) {
      expect(e.details.fieldErrors.some((f: any) => f.code === 'sum_mismatch')).toBe(true);
    }
  });

  it("rejects allocations that exceed configured drift thresholds", () => {
    // Use first TARGET_ALLOCATIONS entry and intentionally set allocation far from target
    const cfg = TARGET_ALLOCATIONS[0];
    const providedPct = (cfg.targetWeight + cfg.driftThreshold + 0.01) * 100; // exceed threshold
    const otherPct = 100 - providedPct;
    const b = makeBody([
      baseAlloc({ vaultId: cfg.vaultId, allocationPct: providedPct }),
      baseAlloc({ vaultId: 'other', allocationPct: otherPct }),
    ]);
    expect(() => assertValidScenarioInput(b)).toThrow(TreasuryValidationError);
    try {
      assertValidScenarioInput(b);
    } catch (e: any) {
      expect(e.details.fieldErrors.some((f: any) => f.code === 'drift_exceeds_threshold')).toBe(true);
    }
  });
});
