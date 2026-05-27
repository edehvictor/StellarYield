import {
  simulateTreasury,
  saveScenario,
  getScenario,
  listScenarios,
  deleteScenario,
  type TreasuryScenario,
  type AllocationPosition,
} from "../services/treasurySimulationService";

const baseAllocations: AllocationPosition[] = [
  { vaultId: "blend", vaultName: "Blend", allocationPct: 60, apy: 6.5, tvlUsd: 12_000_000, riskScore: 8, rotationCostPct: 0.1 },
  { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 40, apy: 11.2, tvlUsd: 4_500_000, riskScore: 6, rotationCostPct: 0.2 },
];

const makeScenario = (overrides: Partial<TreasuryScenario> = {}): TreasuryScenario => ({
  id: `test-${Date.now()}`,
  name: "Test Scenario",
  totalCapitalUsd: 1_000_000,
  allocations: baseAllocations,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("simulateTreasury", () => {
  it("returns a projectedYieldPct > 0 for valid allocations", () => {
    const result = simulateTreasury(makeScenario());
    expect(result.projectedYieldPct).toBeGreaterThan(0);
  });

  it("projectedYieldUsd matches capital × weighted APY", () => {
    const scenario = makeScenario({ totalCapitalUsd: 1_000_000 });
    const result = simulateTreasury(scenario);
    const expected =
      1_000_000 * 0.6 * (6.5 / 100) + 1_000_000 * 0.4 * (11.2 / 100);
    expect(result.projectedYieldUsd).toBeCloseTo(expected, 0);
  });

  it("includes rotation cost for all positions", () => {
    const result = simulateTreasury(makeScenario({ totalCapitalUsd: 1_000_000 }));
    const expected =
      1_000_000 * 0.6 * (0.1 / 100) + 1_000_000 * 0.4 * (0.2 / 100);
    expect(result.totalRotationCostUsd).toBeCloseTo(expected, 0);
  });

  it("warns on high concentration (>50%)", () => {
    const result = simulateTreasury(makeScenario());
    expect(result.concentrationWarnings.length).toBeGreaterThan(0);
    expect(result.concentrationWarnings[0]).toContain("Blend");
  });

  it("no warnings when all allocations are ≤50%", () => {
    const scenario = makeScenario({
      allocations: [
        { ...baseAllocations[0], allocationPct: 50 },
        { ...baseAllocations[1], allocationPct: 50 },
      ],
    });
    const result = simulateTreasury(scenario);
    expect(result.concentrationWarnings).toHaveLength(0);
  });

  it("breakdown has an entry per allocation", () => {
    const result = simulateTreasury(makeScenario());
    expect(result.allocationBreakdown).toHaveLength(2);
  });

  it("liquidityRiskScore is between 0 and 10", () => {
    const result = simulateTreasury(makeScenario());
    expect(result.liquidityRiskScore).toBeGreaterThanOrEqual(0);
    expect(result.liquidityRiskScore).toBeLessThanOrEqual(10);
  });

  it("returns 0 yield for zero capital", () => {
    const result = simulateTreasury(makeScenario({ totalCapitalUsd: 0 }));
    expect(result.projectedYieldPct).toBe(0);
    expect(result.projectedYieldUsd).toBe(0);
  });
});

describe("scenario persistence", () => {
  it("saves and retrieves a scenario", () => {
    const scenario = makeScenario({ id: "persist-1" });
    saveScenario(scenario);
    expect(getScenario("persist-1")).toMatchObject({ id: "persist-1" });
  });

  it("lists saved scenarios", () => {
    const scenario = makeScenario({ id: "list-1" });
    saveScenario(scenario);
    expect(listScenarios().some((s) => s.id === "list-1")).toBe(true);
  });

  it("deletes a scenario", () => {
    const scenario = makeScenario({ id: "delete-1" });
    saveScenario(scenario);
    expect(deleteScenario("delete-1")).toBe(true);
    expect(getScenario("delete-1")).toBeUndefined();
  });

  it("returns false when deleting non-existent scenario", () => {
    expect(deleteScenario("does-not-exist")).toBe(false);
  });
});
