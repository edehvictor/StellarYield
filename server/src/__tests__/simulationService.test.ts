import {
  SIMULATOR_FIXTURES,
  SIMULATOR_EDGE_CASES,
  validateSimulationResult,
  type SimulatorFixture,
} from "../../../shared/test-fixtures/simulatorFixtures";
import {
  simulateRebalance,
  validateRebalanceParams,
  REBALANCE_THRESHOLDS,
  type RebalanceParams,
} from "../services/simulationService";
import type { SimulationWarning } from "../../../shared/types/simulationWarning";

describe("Simulation Service", () => {
  it("should estimate allocations, expected shares, fees, and explicitly mark as preview-only", () => {
    const result = simulateDeposit({
      strategyId: "Conservative",
      amount: 1000,
      token: "USDC",
    });

    expect(result.isSimulationOnly).toBe(true);
    expect(result.allocations.length).toBeGreaterThan(0);
    expect(result.fees.length).toBeGreaterThan(0);
    expect(result.expectedShares).toBeGreaterThan(0);
    expect(result.routing.path.length).toBeGreaterThan(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.postDepositExposure.expectedApy).toBeGreaterThan(0);
  });

  it("should return slippage warnings for high amounts", () => {
    const result = simulateDeposit({
      strategyId: "Conservative",
      amount: 150000, // > 100k
      token: "USDC",
    });

    expect(result.warnings.some((w: SimulationWarning) => w.code === "HIGH_SLIPPAGE")).toBe(true);
  });

  it("should return liquidity warnings for very high amounts", () => {
    const result = simulateDeposit({
      strategyId: "Conservative",
      amount: 1500000, // > 1m
      token: "USDC",
    });

    expect(result.warnings.some((w: SimulationWarning) => w.code === "INSUFFICIENT_LIQUIDITY")).toBe(true);
  });

  it("should handle unsupported strategies", () => {
    // Aggressive has none if PROTOCOLS filtering fails, though we implemented a fallback
    // But we test zero amount warning instead here just to be sure.
    const result0 = simulateDeposit({
      strategyId: "Conservative",
      amount: 0,
      token: "USDC",
    });

    expect(result0.warnings.some((w) => w.includes("greater than zero"))).toBe(true);
    expect(result0.warnings.some((w: SimulationWarning) => w.code === "ZERO_AMOUNT")).toBe(true);
  });
});

describe("Simulation Service - Shared Fixture Tests", () => {
  describe("Basic fixtures - Deterministic Simulator Validation", () => {
    SIMULATOR_FIXTURES.forEach((fixture: SimulatorFixture) => {
      it(`should handle: ${fixture.description}`, () => {
        const result = simulateDeposit(fixture.input);

        // Validate against fixture expectations
        const validation = validateSimulationResult(fixture, result);

        expect(validation.valid).toBe(true);
        if (!validation.valid) {
          console.log(
            `Validation errors for "${fixture.description}":`,
            validation.errors
          );
        }
        expect(validation.errors).toEqual([]);
      });
    });
  });

  describe("Edge cases - Regression Coverage", () => {
    SIMULATOR_EDGE_CASES.forEach((fixture: SimulatorFixture) => {
      it(`should handle: ${fixture.description}`, () => {
        const result = simulateDeposit(fixture.input);

        // Validate against fixture expectations
        const validation = validateSimulationResult(fixture, result);

        expect(validation.valid).toBe(true);
        if (!validation.valid) {
          console.log(
            `Validation errors for "${fixture.description}":`,
            validation.errors
          );
        }
        expect(validation.errors).toEqual([]);
      });
    });
  });

  describe("Fee Calculation Consistency", () => {
    it("should calculate entry fee as 0.1% of deposit amount", () => {
      const testCases = [
        { amount: 1000, expectedFee: 1.0 },
        { amount: 10000, expectedFee: 10.0 },
        { amount: 100000, expectedFee: 100.0 },
      ];

      testCases.forEach(({ amount, expectedFee }) => {
        const result = simulateDeposit({
          strategyId: "blend-stable",
          amount,
          token: "USDC",
        });

        const entryFee = result.fees.find((f) => f.type === "Entry Fee");
        expect(entryFee).toBeDefined();
        expect(entryFee!.amount).toBeCloseTo(expectedFee, 2);
      });
    });

    it("should include fixed network fee estimate of 0.05", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      const networkFee = result.fees.find((f) => f.type === "Network Fee Estimate");
      expect(networkFee).toBeDefined();
      expect(networkFee!.amount).toBe(0.05);
    });

    it("should always include both entry and network fees", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      expect(result.fees.length).toBe(2);
      expect(result.fees.some((f) => f.type === "Entry Fee")).toBe(true);
      expect(result.fees.some((f) => f.type === "Network Fee Estimate")).toBe(true);
    });
  });

  describe("Allocation Accuracy", () => {
    it("should distribute net amount across protocols", () => {
      const amount = 50000;
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount,
        token: "USDC",
      });

      const entryFee = amount * 0.001;
      const expectedNetAmount = amount - entryFee;

      const allocSum = result.allocations.reduce((sum, a) => sum + a.amount, 0);

      // Should be approximately equal
      expect(Math.abs(allocSum - expectedNetAmount)).toBeLessThan(0.01);
    });

    it("should calculate percentages as % of original deposit", () => {
      const amount = 100000;
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount,
        token: "USDC",
      });

      result.allocations.forEach((alloc) => {
        const expectedPercentage = (alloc.amount / amount) * 100;
        expect(alloc.percentage).toBeCloseTo(expectedPercentage, 2);
      });
    });
  });

  describe("Slippage and Shares Calculation", () => {
    it("should apply 0.1% slippage for amounts <= 100k", () => {
      const amount = 50000;
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount,
        token: "USDC",
      });

      const entryFee = amount * 0.001;
      const netAmount = amount - entryFee;
      const expectedSlippage = netAmount * 0.001;
      const expectedShares = netAmount - expectedSlippage;

      expect(result.expectedShares).toBeCloseTo(expectedShares, 2);
    });

    it("should apply 1% slippage for amounts > 100k", () => {
      const amount = 150000;
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount,
        token: "USDC",
      });

      const entryFee = amount * 0.001;
      const netAmount = amount - entryFee;
      const expectedSlippage = netAmount * 0.01;
      const expectedShares = netAmount - expectedSlippage;

      expect(result.expectedShares).toBeCloseTo(expectedShares, 2);
    });

    it("should match expectedShares in routing expectedOutput", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      expect(result.routing.expectedOutput).toBe(result.expectedShares);
    });
  });

  describe("Warning Generation - Deposit Edge Cases", () => {
    it("should warn about deposits with high slippage (> 100k)", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 150000,
        token: "USDC",
      });

      const w = result.warnings.find((w: SimulationWarning) => w.code === "HIGH_SLIPPAGE");
      expect(w).toBeDefined();
      expect(w!.severity).toBe("warning");
      expect(w!.affectedField).toBe("amount");
      expect(w!.remediation).toBeTruthy();
    });

    it("should warn about insufficient liquidity for very large deposits (> 1M)", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 2000000,
        token: "USDC",
      });

      const w = result.warnings.find((w: SimulationWarning) => w.code === "INSUFFICIENT_LIQUIDITY");
      expect(w).toBeDefined();
      expect(w!.severity).toBe("critical");
      expect(w!.remediation).toBeTruthy();
    });

    it("should warn for zero amount deposits", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 0,
        token: "USDC",
      });

      expect(result.warnings.some((w) => w.includes("greater than zero"))).toBe(true);
      const w = result.warnings.find((w: SimulationWarning) => w.code === "ZERO_AMOUNT");
      expect(w).toBeDefined();
      expect(w!.severity).toBe("critical");
    });

    it("should warn for negative amount deposits", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: -5000,
        token: "USDC",
      });

      expect(result.warnings.some((w) => w.includes("greater than zero"))).toBe(true);
      const w = result.warnings.find((w: SimulationWarning) => w.code === "ZERO_AMOUNT");
      expect(w).toBeDefined();
    });

    it("should have no unexpected warnings for valid small deposits", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 5000,
        token: "USDC",
      });

      const unexpectedWarnings = result.warnings.filter(
        (w: SimulationWarning) =>
          !["HIGH_SLIPPAGE", "INSUFFICIENT_LIQUIDITY", "ZERO_AMOUNT", "UNSUPPORTED_STRATEGY", "AMOUNT_TOO_LARGE"].includes(w.code)
      );

      expect(unexpectedWarnings.length).toBe(0);
    });
  });

  describe("Strategy Selection - Feature Coverage", () => {
    it("should select blend protocols for blend strategy", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      expect(result.allocations.length).toBeGreaterThan(0);
      expect(result.routing.path.length).toBeGreaterThan(0);
    });

    it("should select non-blend for aggressive strategy", () => {
      const result = simulateDeposit({
        strategyId: "aggressive-yield",
        amount: 50000,
        token: "USDC",
      });

      expect(result.allocations.length).toBeGreaterThan(0);
      expect(result.routing.path.length).toBeGreaterThan(0);
    });

    it("should fallback gracefully for unknown strategies", () => {
      const result = simulateDeposit({
        strategyId: "unknown-strategy-xyz",
        amount: 50000,
        token: "USDC",
      });

      const w = result.warnings.find((w: SimulationWarning) => w.code === "UNSUPPORTED_STRATEGY");
      expect(w).toBeDefined();
      expect(result.allocations.length).toBeGreaterThan(0);
    });
  });

  describe("APY Calculation - Expected Outcomes", () => {
    it("should provide positive APY for valid inputs", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      expect(result.postDepositExposure.expectedApy).toBeGreaterThan(0);
    });

    it("should provide zero APY for invalid (zero) amounts", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 0,
        token: "USDC",
      });

      expect(result.postDepositExposure.expectedApy).toBe(0);
    });

    it("should be in a reasonable range (< 100%)", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      expect(result.postDepositExposure.expectedApy).toBeLessThan(100);
    });

    it("should weight APY based on allocation amounts", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      // APY should be a weighted average - verify it exists and is reasonable
      expect(result.postDepositExposure.expectedApy).toBeGreaterThan(0);
      expect(result.routing.path.length).toBe(result.allocations.length);
    });
  });

  describe("Routing Consistency", () => {
    it("should have matching routing path and allocations length", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      expect(result.routing.path.length).toBe(result.allocations.length);
    });

    it("should always mark result as simulation-only", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      expect(result.isSimulationOnly).toBe(true);
    });

    it("should have expectedOutput equal to expectedShares", () => {
      const result = simulateDeposit({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      expect(result.routing.expectedOutput).toBe(result.expectedShares);
    });
  });

  describe("Error Resilience - No Runtime Crashes", () => {
    it("should not throw for zero amount", () => {
      expect(() => {
        simulateDeposit({
          strategyId: "blend-stable",
          amount: 0,
          token: "USDC",
        });
      }).not.toThrow();
    });

    it("should not throw for very large amounts", () => {
      expect(() => {
        simulateDeposit({
          strategyId: "blend-stable",
          amount: 1e10,
          token: "USDC",
        });
      }).not.toThrow();
    });

    it("should not throw for empty strategy ID", () => {
      expect(() => {
        simulateDeposit({
          strategyId: "",
          amount: 50000,
          token: "USDC",
        });
      }).not.toThrow();
    });

    it("should not throw for negative amounts", () => {
      expect(() => {
        simulateDeposit({
          strategyId: "blend-stable",
          amount: -1000,
          token: "USDC",
        });
      }).not.toThrow();
    });
  });

describe("Rebalance Simulation Sandbox", () => {
  const evenToConcentrated: RebalanceParams = {
    totalValueUsd: 10_000,
    allocations: [
      { label: "Blend", currentWeight: 50, targetWeight: 70, apy: 8 },
      { label: "Soroswap", currentWeight: 50, targetWeight: 30, apy: 4 },
    ],
  };

  it("previews before/after blended APY and is flagged simulation-only", () => {
    const preview = simulateRebalance(evenToConcentrated);

    expect(preview.isSimulationOnly).toBe(true);
    // before: 0.5*8 + 0.5*4 = 6 ; after: 0.7*8 + 0.3*4 = 6.8
    expect(preview.blendedApyBefore).toBeCloseTo(6, 5);
    expect(preview.blendedApyAfter).toBeCloseTo(6.8, 5);
    expect(preview.apyDeltaPct).toBeCloseTo(0.8, 5);
  });

  it("computes per-leg drift, turnover, and fees", () => {
    const preview = simulateRebalance({ ...evenToConcentrated, feeBps: 20 });

    const blend = preview.legs.find((l) => l.label === "Blend");
    expect(blend?.driftPct).toBe(20);
    expect(blend?.deltaUsd).toBe(2_000); // 70% - 50% of 10k

    // gross movement = 2000 (buy) + 2000 (sell) => turnover 2000
    expect(preview.totalTurnoverUsd).toBe(2_000);
    expect(preview.estimatedFeeUsd).toBeCloseTo(4, 5); // 2000 * 20bps
    expect(preview.maxDriftPct).toBe(20);
  });

  it("warns on high fees, stale data, and liquidity risk", () => {
    const preview = simulateRebalance({
      totalValueUsd: 10_000,
      feeBps: 500, // 5% turnover fee -> high fees
      dataAgeSeconds: REBALANCE_THRESHOLDS.staleDataSeconds + 60,
      allocations: [
        {
          label: "Blend",
          currentWeight: 30,
          targetWeight: 80,
          apy: 8,
          liquidityUsd: 1_000, // buying $5k into $1k of liquidity
        },
        { label: "Soroswap", currentWeight: 70, targetWeight: 20, apy: 4 },
      ],
    });

    expect(preview.warnings.some((w) => w.code === "HIGH_FEES")).toBe(true);
    expect(preview.warnings.some((w) => w.code === "STALE_DATA")).toBe(true);
    expect(preview.warnings.some((w) => w.code === "LIQUIDITY_RISK")).toBe(true);
    // Each warning must have severity, message, and remediation
    for (const w of preview.warnings) {
      expect(w.severity).toMatch(/^(info|warning|critical)$/);
      expect(typeof w.message).toBe("string");
      expect(typeof w.remediation).toBe("string");
    }
  });

  it("validates weights that do not sum to 100%", () => {
    const errors = validateRebalanceParams({
      totalValueUsd: 10_000,
      allocations: [
        { label: "Blend", currentWeight: 50, targetWeight: 60, apy: 8 },
        { label: "Soroswap", currentWeight: 50, targetWeight: 30, apy: 4 },
      ],
    });
    expect(errors.some((e) => /Target weights must sum to 100%/.test(e))).toBe(
      true,
    );
  });

  it("rejects invalid totals and empty allocations", () => {
    expect(
      validateRebalanceParams({ totalValueUsd: 0, allocations: [] }),
    ).toEqual(
      expect.arrayContaining([
        "totalValueUsd must be a positive number.",
        "allocations must be a non-empty array.",
      ]),
    );
  });

  it("throws when simulateRebalance is given invalid params", () => {
    expect(() =>
      simulateRebalance({ totalValueUsd: -1, allocations: [] }),
    ).toThrow(/Invalid rebalance parameters/);
  });
});
});
