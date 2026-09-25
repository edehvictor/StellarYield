/**
 * Tests for RebalanceFeedService
 * Covers API communication, event fetching, polling, and SSE handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RebalanceFeedService } from "./rebalanceFeedService";
import type { RebalanceEvent, RebalanceTriggerReason } from "../../../shared/types/rebalanceEvent";

// Mock fetch
global.fetch = vi.fn();

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
  triggerReason: "drift_threshold" as RebalanceTriggerReason,
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

describe("RebalanceFeedService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("fetchRebalanceEvents", () => {
    it("should fetch rebalance events without filters", async () => {
      const mockResponse: any = {
        events: [mockRebalanceEvent()],
        total: 1,
        hasMore: false,
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await RebalanceFeedService.fetchRebalanceEvents();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/rebalances"),
        expect.any(Object)
      );
      expect(result.events).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);
    });

    it("should fetch rebalance events with vaultId filter", async () => {
      const mockResponse: any = {
        events: [mockRebalanceEvent({ vaultId: "vault-456" })],
        total: 1,
        hasMore: false,
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      await RebalanceFeedService.fetchRebalanceEvents({ vaultId: "vault-456" });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("vaultId=vault-456"),
        expect.any(Object)
      );
    });

    it("should support pagination with limit and offset", async () => {
      const mockResponse: any = {
        events: [mockRebalanceEvent()],
        total: 100,
        hasMore: true,
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      await RebalanceFeedService.fetchRebalanceEvents({
        limit: 20,
        offset: 40,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("limit=20") &&
          expect.stringContaining("offset=40"),
        expect.any(Object)
      );
      expect(global.fetch).toHaveBeenCalled();
    });

    it("should handle fetch errors gracefully", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(RebalanceFeedService.fetchRebalanceEvents()).rejects.toThrow(
        "Failed to fetch rebalance events"
      );
    });

    it("should handle network errors", async () => {
      (global.fetch as any).mockRejectedValueOnce(
        new Error("Network error")
      );

      await expect(RebalanceFeedService.fetchRebalanceEvents()).rejects.toThrow(
        "Network error"
      );
    });
  });

  describe("fetchRecentRebalances", () => {
    it("should fetch recent rebalances for a specific vault", async () => {
      const mockResponse = {
        vaultId: "vault-123",
        events: [mockRebalanceEvent()],
        timestamp: new Date().toISOString(),
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await RebalanceFeedService.fetchRecentRebalances(
        "vault-123"
      );

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("vault-123/recent"),
        expect.any(Object)
      );
      expect(result.events).toHaveLength(1);
      expect(result.vaultId).toBe("vault-123");
    });

    it("should support custom limit parameter", async () => {
      const mockResponse = {
        vaultId: "vault-123",
        events: Array(5).fill(mockRebalanceEvent()),
        timestamp: new Date().toISOString(),
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      await RebalanceFeedService.fetchRecentRebalances("vault-123", 5);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("limit=5"),
        expect.any(Object)
      );
    });
  });

  describe("fetchRebalanceStats", () => {
    it("should fetch rebalance statistics for a vault", async () => {
      const mockResponse = {
        vaultId: "vault-123",
        totalRebalances: 10,
        averageApyImprovement: 0.35,
        mostCommonTrigger: "drift_threshold",
        timestamp: new Date().toISOString(),
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await RebalanceFeedService.fetchRebalanceStats("vault-123");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("vault-123/stats"),
        expect.any(Object)
      );
      expect(result.totalRebalances).toBe(10);
      expect(result.averageApyImprovement).toBe(0.35);
    });
  });

  describe("startPolling", () => {
    it("should start polling for new events at specified interval", async () => {
      vi.useFakeTimers();
      // Set fake time to before the mock event's timestamp (2024-01-15) so events
      // pass the "newer than lastTimestamp" filter inside startPolling.
      vi.setSystemTime(new Date("2024-01-14T00:00:00Z"));

      const mockResponse = {
        vaultId: "vault-123",
        events: [mockRebalanceEvent()],
        timestamp: new Date().toISOString(),
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const onUpdate = vi.fn();
      const unsubscribe = RebalanceFeedService.startPolling(
        "vault-123",
        onUpdate,
        10000
      );

      // poll() is async — flush the microtask queue before asserting
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Initial poll should happen immediately
      expect(onUpdate).toHaveBeenCalled();

      // Fast-forward time to trigger next poll and flush its microtasks
      vi.advanceTimersByTime(10000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(onUpdate).toHaveBeenCalledTimes(2);

      // Unsubscribe and verify no more calls
      unsubscribe();
      vi.advanceTimersByTime(10000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(onUpdate).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("should filter to only new events since last poll", async () => {
      vi.useFakeTimers();

      const now = new Date();
      const oldEvent = mockRebalanceEvent({
        timestamp: new Date(now.getTime() - 60000),
      });
      const newEvent = mockRebalanceEvent({
        timestamp: new Date(now.getTime() + 1000),
      });

      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            vaultId: "vault-123",
            events: [oldEvent, newEvent],
            timestamp: new Date().toISOString(),
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            vaultId: "vault-123",
            events: [newEvent],
            timestamp: new Date().toISOString(),
          }),
        });

      const onUpdate = vi.fn();
      const unsubscribe = RebalanceFeedService.startPolling(
        "vault-123",
        onUpdate,
        10000
      );

      // poll() is async — flush microtasks before asserting
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // First call includes both events
      expect(onUpdate).toHaveBeenCalledTimes(1);

      // Advance time and trigger next poll, then flush
      vi.advanceTimersByTime(10000);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Second call should only include new event
      expect(onUpdate).toHaveBeenCalledTimes(2);

      unsubscribe();
      vi.useRealTimers();
    });

    it("should handle errors during polling gracefully", async () => {
      vi.useFakeTimers();

      (global.fetch as any).mockRejectedValue(new Error("Network error"));

      const onUpdate = vi.fn();
      const unsubscribe = RebalanceFeedService.startPolling(
        "vault-123",
        onUpdate,
        10000
      );

      // poll() is async — flush microtasks before asserting
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Should call with empty events and error flag
      expect(onUpdate).toHaveBeenCalledWith([], true);

      unsubscribe();
      vi.useRealTimers();
    });

    it("should return unsubscribe function", () => {
      vi.useFakeTimers();

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          vaultId: "vault-123",
          events: [],
          timestamp: new Date().toISOString(),
        }),
      });

      const onUpdate = vi.fn();
      const unsubscribe = RebalanceFeedService.startPolling(
        "vault-123",
        onUpdate
      );

      expect(typeof unsubscribe).toBe("function");
      unsubscribe();

      vi.useRealTimers();
    });
  });

  describe("subscribeToRebalanceUpdates (SSE)", () => {
    it("should subscribe to SSE updates", () => {
      const mockEventSource = {
        addEventListener: vi.fn(),
        close: vi.fn(),
      };

      global.EventSource = vi.fn(() => mockEventSource) as any;

      const onUpdate = vi.fn();
      const onError = vi.fn();

      const unsubscribe = RebalanceFeedService.subscribeToRebalanceUpdates(
        "vault-123",
        onUpdate,
        onError
      );

      expect(global.EventSource).toHaveBeenCalledWith(
        expect.stringContaining("vault-123/stream")
      );
      expect(mockEventSource.addEventListener).toHaveBeenCalled();

      unsubscribe();
      expect(mockEventSource.close).toHaveBeenCalled();
    });

    it("should handle SSE rebalance events", () => {
      let rebalanceHandler: ((event: any) => void) | null = null;

      const mockEventSource = {
        addEventListener: vi.fn((event: string, handler: any) => {
          if (event === "rebalance") {
            rebalanceHandler = handler;
          }
        }),
        close: vi.fn(),
      };

      global.EventSource = vi.fn(() => mockEventSource) as any;

      const onUpdate = vi.fn();
      const onError = vi.fn();

      RebalanceFeedService.subscribeToRebalanceUpdates(
        "vault-123",
        onUpdate,
        onError
      );

      // Simulate receiving event
      const mockEvent = {
        data: JSON.stringify(mockRebalanceEvent()),
      };

      rebalanceHandler?.(mockEvent);

      expect(onUpdate).toHaveBeenCalledWith(expect.any(Object));
    });

    it("should handle SSE connection errors", () => {
      let errorHandler: ((event: any) => void) | null = null;

      const mockEventSource = {
        addEventListener: vi.fn((event: string, handler: any) => {
          if (event === "error") {
            errorHandler = handler;
          }
        }),
        close: vi.fn(),
      };

      global.EventSource = vi.fn(() => mockEventSource) as any;

      const onUpdate = vi.fn();
      const onError = vi.fn();

      RebalanceFeedService.subscribeToRebalanceUpdates(
        "vault-123",
        onUpdate,
        onError
      );

      // Simulate error
      errorHandler?.({});

      expect(onError).toHaveBeenCalled();
      expect(mockEventSource.close).toHaveBeenCalled();
    });
  });
});
