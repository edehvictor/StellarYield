/**
 * Treasury scenario fixtures covering bridge failures, delayed relays, and partial cashflow.
 *
 * These fixtures are shared/representative enough to be reused across treasury test suites.
 */

import {
  simulateTreasury,
  compareTreasuryScenarios,
  saveScenario,
  type TreasuryScenario,
  type AllocationPosition,
} from "../services/treasurySimulationService";

export interface TreasuryFixture {
  name: string;
  scenario: TreasuryScenario;
  expectedYieldUsd: number;
  expectedRotationCostUsd: number;
  expectedWarnings: string[];
  expectZeroYield: boolean;
}

function alloc(overrides: Partial<AllocationPosition> = {}): AllocationPosition {
  return {
    vaultId: "vault-1",
    vaultName: "Vault",
    allocationPct: 100,
    apy: 5,
    tvlUsd: 1_000_000,
    riskScore: 5,
    rotationCostPct: 0.1,
    ...overrides,
  };
}

export const FIXTURES: TreasuryFixture[] = [
  {
    name: "bridge_delay_high_rotation_cost",
    scenario: {
      id: "bridge-delay-1",
      name: "Bridge Delay",
      totalCapitalUsd: 1_000_000,
      allocations: [alloc({ vaultId: "delay-vault", vaultName: "Delay Vault", allocationPct: 100, rotationCostPct: 1.5 })],
      createdAt: new Date().toISOString(),
    },
    expectedYieldUsd: 50_000,
    expectedRotationCostUsd: 15_000,
    expectedWarnings: [],
    expectZeroYield: false,
  },
  {
    name: "bridge_failure_zero_apy",
    scenario: {
      id: "bridge-failure-1",
      name: "Bridge Failure",
      totalCapitalUsd: 500_000,
      allocations: [alloc({ vaultId: "failed-bridge", vaultName: "Failed Bridge", apy: 0, rotationCostPct: 0.5 })],
      createdAt: new Date().toISOString(),
    },
    expectedYieldUsd: 0,
    expectedRotationCostUsd: 2_500,
    expectedWarnings: [],
    expectZeroYield: true,
  },
  {
    name: "partial_cashflow_low_risk",
    scenario: {
      id: "partial-cashflow-1",
      name: "Partial Cashflow",
      totalCapitalUsd: 2_000_000,
      allocations: [
        alloc({ vaultId: "a", vaultName: "A", allocationPct: 60, riskScore: 9, rotationCostPct: 0.05 }),
        alloc({ vaultId: "b", vaultName: "B", allocationPct: 40, riskScore: 3, rotationCostPct: 0.4 }),
      ],
      createdAt: new Date().toISOString(),
    },
    expectedYieldUsd: 100_000,
    expectedRotationCostUsd: 3_800,
    expectedWarnings: [],
    expectZeroYield: false,
  },
  {
    name: "zero_capital_after_bridge_slippage",
    scenario: {
      id: "zero-capital-1",
      name: "Zero Capital",
      totalCapitalUsd: 0,
      allocations: [alloc({ vaultId: "x", vaultName: "X", allocationPct: 100 })],
      createdAt: new Date().toISOString(),
    },
    expectedYieldUsd: 0,
    expectedRotationCostUsd: 0,
    expectedWarnings: [],
    expectZeroYield: true,
  },
];

describe("treasury edge case fixtures", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} - deterministic simulation`, () => {
      const result = simulateTreasury(fixture.scenario);
      if (fixture.expectZeroYield) {
        expect(result.projectedYieldPct).toBe(0);
        expect(result.projectedYieldUsd).toBe(0);
      } else {
        expect(result.projectedYieldUsd).toBeCloseTo(fixture.expectedYieldUsd, 0);
        expect(result.totalRotationCostUsd).toBeCloseTo(fixture.expectedRotationCostUsd, 0);
      }
      expect(result.concentrationWarnings).toEqual(
        expect.arrayContaining(
          fixture.expectedWarnings.map((w) => expect.stringContaining(w)),
        ),
      );
    });
  }

  it("persists fixtures without mutation", () => {
    for (const fixture of FIXTURES) {
      saveScenario(fixture.scenario);
    }
  });
});

describe("treasury negative cashflow warnings", () => {
  it("emits NEGATIVE_NET_YIELD warning when rotation costs exceed yield", () => {
    const scenario: TreasuryScenario = {
      id: "negative-yield-1",
      name: "Negative Yield",
      totalCapitalUsd: 1_000_000,
      allocations: [
        alloc({
          vaultId: "high-cost",
          vaultName: "High Cost Vault",
          allocationPct: 100,
          apy: 2,
          rotationCostPct: 5,
        }),
      ],
      createdAt: new Date().toISOString(),
    };

    const result = simulateTreasury(scenario);
    
    expect(result.projectedYieldUsd).toBe(20_000);
    expect(result.totalRotationCostUsd).toBe(50_000);
    expect(result.warnings.some(w => w.code === "NEGATIVE_NET_YIELD")).toBe(true);
    expect(result.concentrationWarnings.some(w => w.includes("negative"))).toBe(true);
  });

  it("does not emit NEGATIVE_NET_YIELD warning when yield exceeds costs", () => {
    const scenario: TreasuryScenario = {
      id: "positive-yield-1",
      name: "Positive Yield",
      totalCapitalUsd: 1_000_000,
      allocations: [
        alloc({
          vaultId: "good-vault",
          vaultName: "Good Vault",
          allocationPct: 100,
          apy: 10,
          rotationCostPct: 0.5,
        }),
      ],
      createdAt: new Date().toISOString(),
    };

    const result = simulateTreasury(scenario);
    
    expect(result.projectedYieldUsd).toBe(100_000);
    expect(result.totalRotationCostUsd).toBe(5_000);
    expect(result.warnings.some(w => w.code === "NEGATIVE_NET_YIELD")).toBe(false);
  });

  it("emits NEGATIVE_CASHFLOW warning in stress runs when net yield turns negative", () => {
    const scenario: TreasuryScenario = {
      id: "stress-negative-1",
      name: "Stress Negative",
      totalCapitalUsd: 1_000_000,
      allocations: [
        alloc({
          vaultId: "marginal-vault",
          vaultName: "Marginal Vault",
          allocationPct: 100,
          apy: 3,
          rotationCostPct: 2,
        }),
      ],
      createdAt: new Date().toISOString(),
    };

    const comparison = compareTreasuryScenarios(scenario, ["severe-crash"]);
    
    const severeRun = comparison.stressRuns.find(r => r.stressId === "severe-crash");
    expect(severeRun).toBeDefined();
    expect(severeRun!.totals.netYieldUsd).toBeLessThan(0);
    expect(severeRun!.structuredWarnings.some(w => w.code === "NEGATIVE_CASHFLOW")).toBe(true);
    expect(severeRun!.warnings.some(w => w.includes("Negative cashflow"))).toBe(true);
  });

  it("emits SEVERE_YIELD_REDUCTION warning when yield drops more than 50%", () => {
    const scenario: TreasuryScenario = {
      id: "severe-reduction-1",
      name: "Severe Reduction",
      totalCapitalUsd: 1_000_000,
      allocations: [
        alloc({
          vaultId: "volatile-vault",
          vaultName: "Volatile Vault",
          allocationPct: 100,
          apy: 10,
          rotationCostPct: 0.5,
        }),
      ],
      createdAt: new Date().toISOString(),
    };

    const comparison = compareTreasuryScenarios(scenario, ["yield-collapse"]);
    
    const yieldCollapseRun = comparison.stressRuns.find(r => r.stressId === "yield-collapse");
    expect(yieldCollapseRun).toBeDefined();
    expect(yieldCollapseRun!.totals.yieldDeltaPct).toBeLessThanOrEqual(-50);
    expect(yieldCollapseRun!.structuredWarnings.some(w => w.code === "SEVERE_YIELD_REDUCTION")).toBe(true);
  });

  it("emits RESERVE_BREACH warning when net yield falls below threshold", () => {
    const scenario: TreasuryScenario = {
      id: "reserve-breach-1",
      name: "Reserve Breach",
      totalCapitalUsd: 1_000_000,
      allocations: [
        alloc({
          vaultId: "low-margin-vault",
          vaultName: "Low Margin Vault",
          allocationPct: 100,
          apy: 5,
          rotationCostPct: 4.8,
        }),
      ],
      createdAt: new Date().toISOString(),
    };

    const comparison = compareTreasuryScenarios(scenario, ["liquidity-crunch"]);
    
    const liquidityCrunchRun = comparison.stressRuns.find(r => r.stressId === "liquidity-crunch");
    expect(liquidityCrunchRun).toBeDefined();
    
    const hasReserveBreach = liquidityCrunchRun!.structuredWarnings.some(w => w.code === "RESERVE_BREACH");
    const hasNegativeCashflow = liquidityCrunchRun!.structuredWarnings.some(w => w.code === "NEGATIVE_CASHFLOW");
    
    expect(hasReserveBreach || hasNegativeCashflow).toBe(true);
  });
});

describe("treasury stress scenario warnings", () => {
  const baseScenario: TreasuryScenario = {
    id: "base-scenario",
    name: "Base Scenario",
    totalCapitalUsd: 1_000_000,
    allocations: [
      alloc({
        vaultId: "stable-vault",
        vaultName: "Stable Vault",
        allocationPct: 100,
        apy: 8,
        rotationCostPct: 1,
      }),
    ],
    createdAt: new Date().toISOString(),
  };

  it("all stress runs include structuredWarnings array", () => {
    const comparison = compareTreasuryScenarios(baseScenario);
    
    for (const stressRun of comparison.stressRuns) {
      expect(stressRun.structuredWarnings).toBeDefined();
      expect(Array.isArray(stressRun.structuredWarnings)).toBe(true);
    }
  });

  it("baseline includes structuredWarnings array", () => {
    const comparison = compareTreasuryScenarios(baseScenario);
    
    expect(comparison.baseline.structuredWarnings).toBeDefined();
    expect(Array.isArray(comparison.baseline.structuredWarnings)).toBe(true);
  });

  it("severe-crash stress run produces warnings for high-risk scenarios", () => {
    const comparison = compareTreasuryScenarios(baseScenario, ["severe-crash"]);
    
    const severeRun = comparison.stressRuns.find(r => r.stressId === "severe-crash");
    expect(severeRun).toBeDefined();
    expect(severeRun!.totals.yieldDeltaPct).toBeLessThan(0);
  });

  it("multiple stress runs can be compared", () => {
    const comparison = compareTreasuryScenarios(baseScenario, ["yield-collapse", "liquidity-crunch", "severe-crash"]);
    
    expect(comparison.stressRuns).toHaveLength(3);
    expect(comparison.summary.worstCaseNetYieldUsd).toBeLessThan(comparison.baseline.totals.netYieldUsd);
  });
});