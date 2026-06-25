/**
 * Treasury scenario fixtures covering bridge failures, delayed relays, and partial cashflow.
 *
 * These fixtures are shared/representative enough to be reused across treasury test suites.
 */

import {
  simulateTreasury,
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
    expectedYieldUsd: 122_000,
    expectedRotationCostUsd: 3_400,
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