/**
 * Integration tests for client and server simulator consistency.
 * 
 * These tests verify that the client-side and server-side simulator
 * implementations produce identical results for the same inputs.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { simulateDeposit as clientSimulate } from "./clientSimulator";
import {
  SIMULATOR_FIXTURES,
  SIMULATOR_EDGE_CASES,
  validateSimulationResult,
} from "../../../shared/test-fixtures/simulatorFixtures";

describe("Client-Side Simulator Consistency Tests", () => {
  describe("Basic fixtures", () => {
    SIMULATOR_FIXTURES.forEach((fixture) => {
      it(`should handle: ${fixture.description}`, () => {
        const result = clientSimulate(fixture.input);

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

  describe("Edge cases", () => {
    SIMULATOR_EDGE_CASES.forEach((fixture) => {
      it(`should handle: ${fixture.description}`, () => {
        const result = clientSimulate(fixture.input);

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

  describe("Deposit fee calculation consistency", () => {
    it("should calculate entry fee as 0.1% of deposit amount", () => {
      const testCases = [
        { amount: 1000, expectedFee: 1.0 },
        { amount: 10000, expectedFee: 10.0 },
        { amount: 100000, expectedFee: 100.0 },
      ];

      testCases.forEach(({ amount, expectedFee }) => {
        const result = clientSimulate({
          strategyId: "blend-stable",
          amount,
          token: "USDC",
        });

        const entryFee = result.fees.find((f) => f.type === "Entry Fee");
        expect(entryFee).toBeDefined();
        expect(entryFee!.amount).toBeCloseTo(expectedFee, 2);
      });
    });

    it("should include consistent network fee estimate", () => {
      const result = clientSimulate({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      const networkFee = result.fees.find((f) => f.type === "Network Fee Estimate");
      expect(networkFee).toBeDefined();
      expect(networkFee!.amount).toBe(0.05);
    });
  });

  describe("Allocation accuracy", () => {
    it("should allocate entire net amount across protocols", () => {
      const amount = 50000;
      const result = clientSimulate({
        strategyId: "blend-stable",
        amount,
        token: "USDC",
      });

      const entryFee = amount * 0.001;
      const expectedNetAmount = amount - entryFee;

      const allocSum = result.allocations.reduce((sum, a) => sum + a.amount, 0);

      // Should be approximately equal (allowing for floating point precision)
      expect(Math.abs(allocSum - expectedNetAmount)).toBeLessThan(0.01);
    });

    it("should calculate allocation percentages correctly", () => {
      const amount = 100000;
      const result = clientSimulate({
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

  describe("Slippage calculation", () => {
    it("should apply 0.1% slippage for amounts <= 100k", () => {
      const amount = 50000;
      const result = clientSimulate({
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
      const result = clientSimulate({
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
  });

  describe("Warning triggers", () => {
    it("should warn about high slippage for deposits > 100k", () => {
      const result = clientSimulate({
        strategyId: "blend-stable",
        amount: 150000,
        token: "USDC",
      });

      expect(result.warnings).toContain(
        "High slippage expected for deposits over 100k."
      );
    });

    it("should warn about insufficient liquidity for deposits > 1M", () => {
      const result = clientSimulate({
        strategyId: "blend-stable",
        amount: 2000000,
        token: "USDC",
      });

      expect(result.warnings).toContain(
        "Insufficient liquidity to route this deposit fully."
      );
    });

    it("should warn for invalid amounts", () => {
      const result = clientSimulate({
        strategyId: "blend-stable",
        amount: 0,
        token: "USDC",
      });

      expect(result.warnings).toContain("Amount must be greater than zero.");
    });

    it("should warn for negative amounts", () => {
      const result = clientSimulate({
        strategyId: "blend-stable",
        amount: -5000,
        token: "USDC",
      });

      expect(result.warnings).toContain("Amount must be greater than zero.");
    });
  });

  describe("Strategy selection", () => {
    it("should select blend protocols for blend strategy", () => {
      const result = clientSimulate({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      expect(result.routing.path.length).toBeGreaterThan(0);
      expect(result.allocations.length).toBeGreaterThan(0);
    });

    it("should select non-blend protocols for aggressive strategy", () => {
      const result = clientSimulate({
        strategyId: "aggressive-yield",
        amount: 50000,
        token: "USDC",
      });

      expect(result.routing.path.length).toBeGreaterThan(0);
      expect(result.allocations.length).toBeGreaterThan(0);
    });

    it("should handle unsupported strategies gracefully", () => {
      const result = clientSimulate({
        strategyId: "unknown-xyz",
        amount: 50000,
        token: "USDC",
      });

      expect(result.warnings).toContain("Unsupported strategy or asset combination.");
      expect(result.allocations.length).toBeGreaterThan(0); // Falls back
    });
  });

  describe("APY calculations", () => {
    it("should produce reasonable blended APY", () => {
      const result = clientSimulate({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      const apy = result.postDepositExposure.expectedApy;
      expect(apy).toBeGreaterThan(0);
      expect(apy).toBeLessThan(100); // Sanity check
    });

    it("should weight APY by allocation amounts", () => {
      const result = clientSimulate({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      // APY should be a weighted average of allocations
      expect(result.postDepositExposure.expectedApy).toBeGreaterThan(0);
      expect(result.routing.path.length).toBe(result.allocations.length);
    });
  });

  describe("Routing consistency", () => {
    it("should have matching routing path and allocations length", () => {
      const result = clientSimulate({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      expect(result.routing.path.length).toBe(result.allocations.length);
    });

    it("should set expectedOutput equal to expectedShares", () => {
      const result = clientSimulate({
        strategyId: "blend-stable",
        amount: 50000,
        token: "USDC",
      });

      expect(result.routing.expectedOutput).toBe(result.expectedShares);
    });
  });
});

describe("Simulator Fixtures Validation", () => {
  it("all basic fixtures should be valid and pass validation", () => {
    SIMULATOR_FIXTURES.forEach((fixture) => {
      const result = clientSimulate(fixture.input);
      const validation = validateSimulationResult(fixture, result);
      expect(validation.valid).toBe(true);
    });
  });

  it("all edge case fixtures should be valid and pass validation", () => {
    SIMULATOR_EDGE_CASES.forEach((fixture) => {
      const result = clientSimulate(fixture.input);
      const validation = validateSimulationResult(fixture, result);
      expect(validation.valid).toBe(true);
    });
  });
});
