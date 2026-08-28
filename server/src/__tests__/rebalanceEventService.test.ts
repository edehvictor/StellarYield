const mockPrisma = {
  rebalanceEvent: {
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};
(global as any).__mockPrisma = mockPrisma;

// Mock PrismaClient
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => (global as any).__mockPrisma),
}));

import { RebalanceEventService } from "../services/rebalanceEventService";
import type {
  RebalanceEvent,
  RebalanceAllocation,
} from "../../../shared/types/rebalanceEvent";

const prisma = mockPrisma;

const mockRebalanceEvent = (overrides?: Partial<RebalanceEvent>): RebalanceEvent => ({
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
  ...overrides,
});

describe("RebalanceEventService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getRebalanceEvents", () => {
    it("should fetch all rebalance events with default pagination", async () => {
      const mockEvents = [
        mockRebalanceEvent({ id: "1" }),
        mockRebalanceEvent({ id: "2" }),
      ];

      (prisma.rebalanceEvent.findMany as any).mockResolvedValue(mockEvents);
      (prisma.rebalanceEvent.count as any).mockResolvedValue(2);

      const result = await RebalanceEventService.getRebalanceEvents();

      expect(result.events).toEqual(mockEvents);
      expect(result.total).toBe(2);
      expect(result.hasMore).toBe(false);
    });

    it("should filter by vaultId", async () => {
      const mockEvents = [mockRebalanceEvent({ vaultId: "vault-456" })];

      (prisma.rebalanceEvent.findMany as any).mockResolvedValue(mockEvents);
      (prisma.rebalanceEvent.count as any).mockResolvedValue(1);

      await RebalanceEventService.getRebalanceEvents({ vaultId: "vault-456" });

      expect(prisma.rebalanceEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ vaultId: "vault-456" }),
        })
      );
    });

    it("should support pagination", async () => {
      const mockEvents = [mockRebalanceEvent()];

      (prisma.rebalanceEvent.findMany as any).mockResolvedValue(mockEvents);
      (prisma.rebalanceEvent.count as any).mockResolvedValue(100);

      const result = await RebalanceEventService.getRebalanceEvents({
        limit: 20,
        offset: 40,
      });

      expect(result.hasMore).toBe(true);
      expect(prisma.rebalanceEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 20,
          skip: 40,
        })
      );
    });

    it("should enforce maximum limit of 100", async () => {
      (prisma.rebalanceEvent.findMany as any).mockResolvedValue([]);
      (prisma.rebalanceEvent.count as any).mockResolvedValue(0);

      await RebalanceEventService.getRebalanceEvents({ limit: 500 });

      expect(prisma.rebalanceEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
        })
      );
    });
  });

  describe("createRebalanceEvent", () => {
    it("should create a new rebalance event", async () => {
      const eventData = mockRebalanceEvent();
      const { id, ...dataWithoutId } = eventData;

      (prisma.rebalanceEvent.create as any).mockResolvedValue(eventData);

      const result = await RebalanceEventService.createRebalanceEvent(dataWithoutId);

      expect(result).toEqual(eventData);
      expect(prisma.rebalanceEvent.create).toHaveBeenCalled();
    });

    it("should convert timestamp to Date object", async () => {
      const eventData = mockRebalanceEvent();
      const { id, ...dataWithoutId } = eventData;

      (prisma.rebalanceEvent.create as any).mockResolvedValue(eventData);

      await RebalanceEventService.createRebalanceEvent(dataWithoutId);

      expect(prisma.rebalanceEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            timestamp: expect.any(Date),
          }),
        })
      );
    });
  });

  describe("updateRebalanceEvent", () => {
    it("should update a rebalance event", async () => {
      const eventData = mockRebalanceEvent();

      (prisma.rebalanceEvent.update as any).mockResolvedValue(eventData);

      const result = await RebalanceEventService.updateRebalanceEvent(
        "rebalance-1",
        { executionStatus: "completed" }
      );

      expect(result).toEqual(eventData);
      expect(prisma.rebalanceEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "rebalance-1" },
          data: { executionStatus: "completed" },
        })
      );
    });
  });

  describe("getRecentRebalances", () => {
    it("should fetch recent rebalances for a vault", async () => {
      const mockEvents = [
        mockRebalanceEvent({ id: "1" }),
        mockRebalanceEvent({ id: "2" }),
      ];

      (prisma.rebalanceEvent.findMany as any).mockResolvedValue(mockEvents);

      const result = await RebalanceEventService.getRecentRebalances(
        "vault-123",
        10
      );

      expect(result).toEqual(mockEvents);
      expect(prisma.rebalanceEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { vaultId: "vault-123" },
          take: 10,
        })
      );
    });

    it("should default to limit of 10", async () => {
      (prisma.rebalanceEvent.findMany as any).mockResolvedValue([]);

      await RebalanceEventService.getRecentRebalances("vault-123");

      expect(prisma.rebalanceEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
        })
      );
    });

    it("should order by timestamp descending", async () => {
      (prisma.rebalanceEvent.findMany as any).mockResolvedValue([]);

      await RebalanceEventService.getRecentRebalances("vault-123");

      expect(prisma.rebalanceEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { timestamp: "desc" },
        })
      );
    });
  });

  describe("getRebalanceStats", () => {
    it("should return zero stats for vault with no events", async () => {
      (prisma.rebalanceEvent.findMany as any).mockResolvedValue([]);

      const stats = await RebalanceEventService.getRebalanceStats("vault-123");

      expect(stats.totalRebalances).toBe(0);
      expect(stats.averageApyImprovement).toBe(0);
    });

    it("should calculate average APY improvement", async () => {
      const events = [
        mockRebalanceEvent({
          id: "1",
          expectedOutcome: {
            ...mockRebalanceEvent().expectedOutcome,
            apyChangePercent: 0.5,
          },
        }),
        mockRebalanceEvent({
          id: "2",
          expectedOutcome: {
            ...mockRebalanceEvent().expectedOutcome,
            apyChangePercent: 0.3,
          },
        }),
      ];

      (prisma.rebalanceEvent.findMany as any).mockResolvedValue(events);

      const stats = await RebalanceEventService.getRebalanceStats("vault-123");

      expect(stats.totalRebalances).toBe(2);
      expect(stats.averageApyImprovement).toBeCloseTo(0.4, 2);
    });

    it("should track most common trigger reason", async () => {
      const events = [
        mockRebalanceEvent({
          id: "1",
          triggerReason: "drift_threshold",
        }),
        mockRebalanceEvent({
          id: "2",
          triggerReason: "drift_threshold",
        }),
        mockRebalanceEvent({
          id: "3",
          triggerReason: "apy_optimization",
        }),
      ];

      (prisma.rebalanceEvent.findMany as any).mockResolvedValue(events);

      const stats = await RebalanceEventService.getRebalanceStats("vault-123");

      expect(stats.mostCommonTrigger).toBe("drift_threshold");
      expect(stats.triggerDistribution.drift_threshold).toBe(2);
      expect(stats.triggerDistribution.apy_optimization).toBe(1);
    });

    it("should count completed vs pending rebalances", async () => {
      const events = [
        mockRebalanceEvent({
          id: "1",
          executionStatus: "completed",
        }),
        mockRebalanceEvent({
          id: "2",
          executionStatus: "completed",
        }),
        mockRebalanceEvent({
          id: "3",
          executionStatus: "pending",
        }),
      ];

      (prisma.rebalanceEvent.findMany as any).mockResolvedValue(events);

      const stats = await RebalanceEventService.getRebalanceStats("vault-123");

      expect(stats.totalRebalances).toBe(3);
      expect(stats.completedRebalances).toBe(2);
    });
  });

  describe("calculateAllocationChanges", () => {
    it("should calculate changes for modified allocations", () => {
      const before: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 50000, percentage: 50 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 50000, percentage: 50 },
      ];

      const after: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 60000, percentage: 60 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 40000, percentage: 40 },
      ];

      const result = RebalanceEventService.calculateAllocationChanges(before, after);

      expect(result.changes.Blend).toEqual({
        before: 50,
        after: 60,
        delta: 10,
      });
      expect(result.changes.Aave).toEqual({
        before: 50,
        after: 40,
        delta: -10,
      });
    });

    it("should handle new allocations", () => {
      const before: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 100000, percentage: 100 },
      ];

      const after: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 50000, percentage: 50 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 50000, percentage: 50 },
      ];

      const result = RebalanceEventService.calculateAllocationChanges(before, after);

      expect(result.changes.Blend).toEqual({
        before: 100,
        after: 50,
        delta: -50,
      });
      expect(result.changes.Aave).toEqual({
        before: 0,
        after: 50,
        delta: 50,
      });
    });

    it("should calculate total drift", () => {
      const before: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 50000, percentage: 50 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 50000, percentage: 50 },
      ];

      const after: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 70000, percentage: 70 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 30000, percentage: 30 },
      ];

      const result = RebalanceEventService.calculateAllocationChanges(before, after);

      expect(result.totalDrift).toBeCloseTo(40, 1); // |20| + |-20|
    });

    it("should handle no changes", () => {
      const before: RebalanceAllocation[] = [
        { protocol: "Blend", assetSymbol: "USDC", amount: 50000, percentage: 50 },
        { protocol: "Aave", assetSymbol: "USDC", amount: 50000, percentage: 50 },
      ];

      const result = RebalanceEventService.calculateAllocationChanges(before, before);

      expect(result.totalDrift).toBe(0);
      expect(result.changes.Blend.delta).toBe(0);
      expect(result.changes.Aave.delta).toBe(0);
    });
  });
});
