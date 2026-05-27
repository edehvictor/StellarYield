/**
 * Treasury Scenario Preset Library Tests (#416)
 *
 * Tests for preset definitions, allocation sum validation,
 * preset loading into simulation, and simulation payloads.
 */

import { TREASURY_PRESETS, type TreasuryPreset } from "../../config/treasuryPresets";
import {
  simulateTreasury,
  isValidAllocationPayload,
  type AllocationPosition,
  type TreasuryScenario,
} from "../../services/treasurySimulationService";

// ── Preset definitions ────────────────────────────────────────────────────────

describe("TREASURY_PRESETS", () => {
  it("defines all four required presets", () => {
    const ids = TREASURY_PRESETS.map((p) => p.id);
    expect(ids).toContain("conservative");
    expect(ids).toContain("balanced");
    expect(ids).toContain("aggressive");
    expect(ids).toContain("liquidity-defense");
  });

  it("each preset has a name and description", () => {
    for (const preset of TREASURY_PRESETS) {
      expect(typeof preset.name).toBe("string");
      expect(preset.name.trim().length).toBeGreaterThan(0);
      expect(typeof preset.description).toBe("string");
      expect(preset.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("each preset allocation sums to exactly 100%", () => {
    for (const preset of TREASURY_PRESETS) {
      const total = preset.allocations.reduce((sum, a) => sum + a.allocationPct, 0);
      expect(total).toBeCloseTo(100, 5);
    }
  });

  it("each preset allocation entry has required fields", () => {
    for (const preset of TREASURY_PRESETS) {
      for (const alloc of preset.allocations) {
        expect(typeof alloc.vaultId).toBe("string");
        expect(alloc.vaultId.trim().length).toBeGreaterThan(0);
        expect(typeof alloc.vaultName).toBe("string");
        expect(alloc.vaultName.trim().length).toBeGreaterThan(0);
        expect(typeof alloc.allocationPct).toBe("number");
        expect(alloc.allocationPct).toBeGreaterThan(0);
      }
    }
  });

  it("conservative preset has highest Blend allocation", () => {
    const conservative = TREASURY_PRESETS.find((p) => p.id === "conservative")!;
    const blend = conservative.allocations.find((a) => a.vaultId === "blend")!;
    expect(blend.allocationPct).toBeGreaterThanOrEqual(50);
  });

  it("aggressive preset has highest Soroswap allocation", () => {
    const aggressive = TREASURY_PRESETS.find((p) => p.id === "aggressive")!;
    const soroswap = aggressive.allocations.find((a) => a.vaultId === "soroswap")!;
    expect(soroswap.allocationPct).toBeGreaterThanOrEqual(50);
  });
});

// ── isValidAllocationPayload ──────────────────────────────────────────────────

const PRESET_DEFAULTS: Record<string, Omit<AllocationPosition, "vaultId" | "vaultName" | "allocationPct">> = {
  blend: { apy: 6.5, tvlUsd: 12_000_000, riskScore: 8, rotationCostPct: 0.1 },
  soroswap: { apy: 11.2, tvlUsd: 4_500_000, riskScore: 6, rotationCostPct: 0.2 },
  defindex: { apy: 8.9, tvlUsd: 8_000_000, riskScore: 5, rotationCostPct: 0.15 },
};

function presetToAllocations(preset: TreasuryPreset): AllocationPosition[] {
  return preset.allocations.map((a) => ({
    ...a,
    ...(PRESET_DEFAULTS[a.vaultId] ?? { apy: 5, tvlUsd: 1_000_000, riskScore: 5, rotationCostPct: 0.1 }),
  }));
}

describe("isValidAllocationPayload", () => {
  it("accepts allocations derived from each preset", () => {
    for (const preset of TREASURY_PRESETS) {
      const allocations = presetToAllocations(preset);
      expect(isValidAllocationPayload(allocations)).toBe(true);
    }
  });

  it("rejects empty array", () => {
    expect(isValidAllocationPayload([])).toBe(false);
  });

  it("rejects allocations that do not sum to 100", () => {
    const allocations: AllocationPosition[] = [
      { vaultId: "blend", vaultName: "Blend", allocationPct: 60, apy: 6.5, tvlUsd: 1_000_000, riskScore: 8, rotationCostPct: 0.1 },
      { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 30, apy: 11.2, tvlUsd: 1_000_000, riskScore: 6, rotationCostPct: 0.2 },
      // total = 90, not 100
    ];
    expect(isValidAllocationPayload(allocations)).toBe(false);
  });

  it("rejects allocations with missing required fields", () => {
    const bad = [{ vaultId: "blend", allocationPct: 100 }];
    expect(isValidAllocationPayload(bad)).toBe(false);
  });

  it("rejects non-array input", () => {
    expect(isValidAllocationPayload(null)).toBe(false);
    expect(isValidAllocationPayload("string")).toBe(false);
  });
});

// ── simulateTreasury with presets ─────────────────────────────────────────────

function makeScenario(preset: TreasuryPreset, totalCapitalUsd = 1_000_000): TreasuryScenario {
  return {
    id: `test-${preset.id}`,
    name: preset.name,
    totalCapitalUsd,
    allocations: presetToAllocations(preset),
    createdAt: new Date().toISOString(),
  };
}

describe("simulateTreasury with presets", () => {
  for (const preset of TREASURY_PRESETS) {
    it(`produces a valid simulation result for the ${preset.name} preset`, () => {
      const scenario = makeScenario(preset);
      const result = simulateTreasury(scenario);

      expect(result.scenarioId).toBe(scenario.id);
      expect(result.scenarioName).toBe(preset.name);
      expect(result.projectedYieldPct).toBeGreaterThan(0);
      expect(result.projectedYieldUsd).toBeGreaterThan(0);
      expect(result.liquidityRiskScore).toBeGreaterThanOrEqual(0);
      expect(result.liquidityRiskScore).toBeLessThanOrEqual(10);
      expect(result.allocationBreakdown).toHaveLength(preset.allocations.length);
    });
  }

  it("allocation breakdown capital sums to totalCapitalUsd", () => {
    const preset = TREASURY_PRESETS.find((p) => p.id === "balanced")!;
    const scenario = makeScenario(preset, 500_000);
    const result = simulateTreasury(scenario);

    const totalCapital = result.allocationBreakdown.reduce((sum, b) => sum + b.capitalUsd, 0);
    expect(totalCapital).toBeCloseTo(500_000, 0);
  });

  it("conservative preset has lower projected yield than aggressive", () => {
    const conservative = makeScenario(TREASURY_PRESETS.find((p) => p.id === "conservative")!);
    const aggressive = makeScenario(TREASURY_PRESETS.find((p) => p.id === "aggressive")!);

    const conservativeResult = simulateTreasury(conservative);
    const aggressiveResult = simulateTreasury(aggressive);

    expect(aggressiveResult.projectedYieldPct).toBeGreaterThan(conservativeResult.projectedYieldPct);
  });
});
