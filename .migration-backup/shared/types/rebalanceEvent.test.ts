/**
 * Tests for rebalanceEvent types and helper functions
 * Covers formatting, delta calculation, and type validations.
 */

import { describe, it, expect } from "vitest";
import {
  formatRebalanceEvent,
  calculateAllocationDelta,
  type RebalanceEvent,
  type RebalanceAllocation,
} from "../rebalanceEvent";

const mockEvent = (): RebalanceEvent => ({
  id: "rebalance-1",
  vaultId: "vault-123",
  vaultName: "Conservative Strategy",
  timestamp: new Date("2024-01-15T10:30:00Z"),
  beforeAllocation: [
    { protocol: "Blend", assetSymbol: "USDC", amount: 50000, percentage: 50 },
    { protocol: "Aave", assetSymbol: "USDC", amount: 50000, percentage: 50 },
  ],
  beforeTotalValue: 100000,
  afterAllocation: [
    { protocol: "Blend", assetSymbol: "USDC", amount: 60000, percentage: 60 },
    { protocol: "Aave", assetSymbol: "USDC", amount: 40000, percentage: 40 },
  ],
  afterTotalValue: 100000,
  triggerReason: "drift_threshold",
  triggerDetails: {
    driftPercentage: 12.5,
  },
  expectedOutcome: {
    apyChangePercent: 0.5,
    estimatedGainUsd: 150,
    riskScore: 3.2,
  },
  executionStatus: "completed",
  executionDetails: {
    transactionHash: "0x123456789abcdef",
    gasCost: 2.5,
    slippagePercent: 0.1,
    actualGainUsd: 140,
  },
  riskNotes: ["Increased Blend exposure may increase yield volatility"],
});

describe("rebalanceEvent Types and Helpers", () => {
  describe("formatRebalanceEvent", () => {
    it("should format event with drift trigger", () => {
      const event = mockEvent();

      const formatted = formatRebalanceEvent(event);

      expect(formatted.title).toBe("Conservative Strategy Rebalanced");
      expect(formatted.description).toContain("Drift Threshold");
      expect(formatted.description).toContain("12.5% drift");
      expect(formatted.impact).toContain("+0.50% APY");
      expect(formatted.impact).toContain("$150.00 expected gain");
    });

    it("should format event with APY optimization trigger", () => {
      const event = mockEvent();
      event.triggerReason = "apy_optimization";
      event.triggerDetails = {
        apyImprovement: 50,
      };

      const formatted = formatRebalanceEvent(event);

      expect(formatted.description).toContain("Apy Optimization");
      expect(formatted.description).toContain("50 bps APY improvement");
    });

    it("should format negative APY changes", () => {
      const event = mockEvent();
      event.expectedOutcome.apyChangePercent = -0.25;

      const formatted = formatRebalanceEvent(event);

      expect(formatted.impact).toContain("-0.25% APY");
    });

    it("should handle various trigger reasons", () => {
      const triggers = [
        "drift_threshold",
        "apy_optimization",
        "risk_mitigation",
        "liquidity_adjustment",
        "manual_trigger",
        "scheduled_rebalance",
      ];

      triggers.forEach((trigger) => {
        const event = mockEvent();
        event.triggerReason = trigger as any;

        const formatted = formatRebalanceEvent(event);

        expect(formatted.description).not.toBeEmpty();
        expect(formatted.title).toBe("Conservative Strategy Rebalanced");
      });
    });
  });

  describe("calculateAllocationDelta", () => {
    it("should calculate percentage changes", () => {
      const before: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 50000, percentage: 50 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 50000, percentage: 50 },
      ];

      const after: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 60000, percentage: 60 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 40000, percentage: 40 },
      ];

      const delta = calculateAllocationDelta(before, after);

      expect(delta.Blend).toBe(10);
      expect(delta.Aave).toBe(-10);
    });

    it("should handle additions", () => {
      const before: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 100000, percentage: 100 },
      ];

      const after: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 50000, percentage: 50 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 50000, percentage: 50 },
      ];

      const delta = calculateAllocationDelta(before, after);

      expect(delta.Blend).toBe(-50);
      expect(delta.Aave).toBe(50);
    });

    it("should handle zero changes", () => {
      const allocations: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 50000, percentage: 50 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 50000, percentage: 50 },
      ];

      const delta = calculateAllocationDelta(allocations, allocations);

      expect(delta.Blend).toBe(0);
      expect(delta.Aave).toBe(0);
    });

    it("should handle empty allocations", () => {
      const delta = calculateAllocationDelta([], []);

      expect(Object.keys(delta).length).toBe(0);
    });

    it("should track all protocols involved", () => {
      const before: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 50000, percentage: 50 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 25000, percentage: 25 },
      ];

      const after: RebalanceAllocation[] = [
        { protocol: "Aave", assetSymbol: "USDC", amount: 50000, percentage: 50 },
        { protocol: "Compound", assetSymbol: "USDC", amount: 50000, percentage: 50 },
      ];

      const delta = calculateAllocationDelta(before, after);

      expect("Blend" in delta).toBe(true);
      expect("Aave" in delta).toBe(true);
      expect("Compound" in delta).toBe(true);
      expect(delta.Blend).toBe(-50);
      expect(delta.Aave).toBe(25);
      expect(delta.Compound).toBe(50);
    });
  });

  describe("Type Validation", () => {
    it("should allow complete RebalanceEvent", () => {
      const event: RebalanceEvent = mockEvent();

      expect(event).toBeDefined();
      expect(event.id).toBeDefined();
      expect(event.vaultId).toBeDefined();
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    it("should have valid allocation structure", () => {
      const allocation: RebalanceAllocation = {
        protocol: "Blend",
        assetSymbol: "USDC",
        amount: 50000,
        percentage: 50,
      };

      expect(allocation.protocol).toBeDefined();
      expect(allocation.assetSymbol).toBeDefined();
      expect(allocation.amount).toBeGreaterThanOrEqual(0);
      expect(allocation.percentage).toBeGreaterThanOrEqual(0);
      expect(allocation.percentage).toBeLessThanOrEqual(100);
    });

    it("should support all trigger reasons", () => {
      const triggers = [
        "drift_threshold",
        "apy_optimization",
        "risk_mitigation",
        "liquidity_adjustment",
        "manual_trigger",
        "scheduled_rebalance",
      ];

      triggers.forEach((trigger) => {
        const event = mockEvent();
        event.triggerReason = trigger as any;

        expect(event.triggerReason).toBeDefined();
      });
    });

    it("should support all execution statuses", () => {
      const statuses = ["completed", "pending", "failed"];

      statuses.forEach((status) => {
        const event = mockEvent();
        event.executionStatus = status as any;

        expect(event.executionStatus).toBeDefined();
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle very small percentage changes", () => {
      const before: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 50000, percentage: 50 },
      ];

      const after: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 50010, percentage: 50.01 },
      ];

      const delta = calculateAllocationDelta(before, after);

      expect(delta.Blend).toBeCloseTo(0.01, 2);
    });

    it("should handle large allocations", () => {
      const before: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 1000000000, percentage: 100 },
      ];

      const after: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 500000000, percentage: 50 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 500000000, percentage: 50 },
      ];

      const delta = calculateAllocationDelta(before, after);

      expect(delta.Blend).toBe(-50);
      expect(delta.Aave).toBe(50);
    });

    it("should format events with all risk notes", () => {
      const event = mockEvent();
      event.riskNotes = [
        "High slippage expected",
        "Liquidity constraints may apply",
        "Market volatility high",
      ];

      const formatted = formatRebalanceEvent(event);

      expect(formatted).toBeDefined();
      expect(formatted.title).toBeDefined();
    });
  });
});
