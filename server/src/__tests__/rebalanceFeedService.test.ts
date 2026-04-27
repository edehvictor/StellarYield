import {
  getRebalanceFeed,
  getLatestRebalance,
  computeChanges,
} from "../services/rebalanceFeedService";
import { connectToDatabase } from "../db/database";

jest.mock("../db/database", () => ({
  connectToDatabase: jest.fn().mockResolvedValue(true),
}));

jest.mock("../models/VaultRebalanceEvent", () => {
  const mockFind = jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    }),
  });
  const mockFindOne = jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    }),
  });
  const mockFindById = jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue(null),
  });
  const mockCreate = jest.fn();

  return {
    VaultRebalanceEventModel: {
      find: mockFind,
      findOne: mockFindOne,
      findById: mockFindById,
      create: mockCreate,
    },
  };
});

jest.mock("../models/VaultRebalanceEvent", () => ({
  VaultRebalanceEventModel: {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    findOne: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    }),
    create: jest.fn().mockResolvedValue({
      _id: "event123",
      vaultId: "vault1",
      vaultName: "Test Vault",
      timestamp: new Date(),
      triggerReason: "Test",
      expectedOutcome: "Test",
      riskNote: "",
      beforeAllocations: [],
      afterAllocations: [],
      status: "completed",
    }),
  },
}));

import type { AllocationBreakdown } from "../models/VaultRebalanceEvent";

describe("rebalanceFeedService", () => {
  describe("computeChanges", () => {
    it("computes changes correctly for new assets", () => {
      const before: AllocationBreakdown[] = [
        { assetId: "asset1", assetName: "USDC", weight: 50, value: 50000 },
      ];
      const after: AllocationBreakdown[] = [
        { assetId: "asset1", assetName: "USDC", weight: 30, value: 30000 },
        { assetId: "asset2", assetName: "USDT", weight: 70, value: 70000 },
      ];

      const changes = computeChanges(before, after);

      expect(changes).toHaveLength(2);
      const asset1Change = changes.find((c) => c.assetId === "asset1");
      expect(asset1Change?.beforeWeight).toBe(50);
      expect(asset1Change?.afterWeight).toBe(30);
      expect(asset1Change?.weightChange).toBe(-20);
      const asset2Change = changes.find((c) => c.assetId === "asset2");
      expect(asset2Change?.beforeWeight).toBe(0);
      expect(asset2Change?.afterWeight).toBe(70);
    });

    it("handles empty before allocations", () => {
      const before: AllocationBreakdown[] = [];
      const after: AllocationBreakdown[] = [
        { assetId: "asset1", assetName: "USDC", weight: 100, value: 100000 },
      ];

      const changes = computeChanges(before, after);

      expect(changes).toHaveLength(1);
      expect(changes[0].assetId).toBe("asset1");
      expect(changes[0].beforeWeight).toBe(0);
      expect(changes[0].afterWeight).toBe(100);
    });

    it("handles empty after allocations", () => {
      const before: AllocationBreakdown[] = [
        { assetId: "asset1", assetName: "USDC", weight: 100, value: 100000 },
      ];
      const after: AllocationBreakdown[] = [];

      const changes = computeChanges(before, after);

      expect(changes).toHaveLength(1);
      expect(changes[0].assetId).toBe("asset1");
      expect(changes[0].beforeWeight).toBe(100);
      expect(changes[0].afterWeight).toBe(0);
      expect(changes[0].weightChange).toBe(-100);
    });

    it("handles both empty allocations", () => {
      const changes = computeChanges([], []);

      expect(changes).toHaveLength(0);
    });
  });

  describe("getRebalanceFeed", () => {
    it("returns empty array when no database", async () => {
      (connectToDatabase as jest.Mock).mockResolvedValueOnce(null);

      const result = await getRebalanceFeed();

      expect(result).toEqual([]);
    });

    it("accepts limit parameter", async () => {
      const result = await getRebalanceFeed(undefined, 10);

      expect(Array.isArray(result)).toBe(true);
    });

    it("accepts vaultId filter", async () => {
      const result = await getRebalanceFeed("vault1", 5);

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getLatestRebalance", () => {
    it("returns null when no database", async () => {
      (connectToDatabase as jest.Mock).mockResolvedValueOnce(null);

      const result = await getLatestRebalance("vault1");

      expect(result).toBeNull();
    });

    it("returns null when no events found", async () => {
      const result = await getLatestRebalance("nonexistent");

      expect(result).toBeNull();
    });
  });
});