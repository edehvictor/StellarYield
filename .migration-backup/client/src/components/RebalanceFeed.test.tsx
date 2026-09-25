/**
 * Tests for RebalanceFeed React component
 * Covers rendering, user interactions, polling, error states, and empty states.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RebalanceFeed } from "./RebalanceFeed";
import { RebalanceFeedService } from "../services/rebalanceFeedService";
import type { RebalanceEvent } from "../../../shared/types/rebalanceEvent";

vi.mock("../services/rebalanceFeedService");

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

describe("RebalanceFeed Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Loading State", () => {
    it("should show loading spinner when fetching events", async () => {
      (RebalanceFeedService.fetchRecentRebalances as any).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ vaultId: "vault-123", events: [], timestamp: new Date().toISOString() }), 1000);
          })
      );

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      expect(screen.getByText("Loading rebalance events...")).toBeInTheDocument();
    });

    it("should have loading class on refresh button during fetch", async () => {
      (RebalanceFeedService.fetchRecentRebalances as any).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ vaultId: "vault-123", events: [], timestamp: new Date().toISOString() }), 1000);
          })
      );

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      const button = screen.getByRole("button", { name: "Refresh" });
      expect(button).toBeDisabled();
    });
  });

  describe("Empty State", () => {
    it("should display empty state when no events exist", async () => {
      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      await waitFor(() => {
        expect(
          screen.getByText("No rebalance events yet")
        ).toBeInTheDocument();
        expect(
          screen.getByText(/Rebalances will appear here/)
        ).toBeInTheDocument();
      });
    });

    it("should show appropriate message in empty state", async () => {
      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [],
        timestamp: new Date().toISOString(),
      });

      render(
        <RebalanceFeed vaultId="vault-123" vaultName="Test Vault" enablePolling={false} />
      );

      await waitFor(() => {
        expect(
          screen.getByText("No rebalance events yet")
        ).toBeInTheDocument();
      });
    });
  });

  describe("Displaying Events", () => {
    it("should display rebalance events when loaded", async () => {
      const event = mockRebalanceEvent();

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [event],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      await waitFor(() => {
        expect(screen.getByText("Conservative Strategy")).toBeInTheDocument();
      });
    });

    it("should display multiple events in order", async () => {
      const events = [
        mockRebalanceEvent({ id: "1", timestamp: new Date("2024-01-15T10:30:00Z") }),
        mockRebalanceEvent({ id: "2", timestamp: new Date("2024-01-14T10:30:00Z") }),
      ];

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events,
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      await waitFor(() => {
        const cards = screen.getAllByText("Conservative Strategy");
        expect(cards).toHaveLength(2);
      });
    });

    it("should display APY change with correct styling", async () => {
      const event = mockRebalanceEvent({ expectedOutcome: { ...mockRebalanceEvent().expectedOutcome, apyChangePercent: 0.5 } });

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [event],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      await waitFor(() => {
        expect(screen.getByText(/\+0.50% APY/)).toBeInTheDocument();
      });
    });

    it("should display negative APY changes correctly", async () => {
      const event = mockRebalanceEvent({
        expectedOutcome: {
          ...mockRebalanceEvent().expectedOutcome,
          apyChangePercent: -0.25,
        },
      });

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [event],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      await waitFor(() => {
        expect(screen.getByText(/-0.25% APY/)).toBeInTheDocument();
      });
    });
  });

  describe("Event Details - Expanded View", () => {
    it("should show expanded event details when clicking expand button", async () => {
      const event = mockRebalanceEvent();

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [event],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      await waitFor(() => {
        const expandButton = screen.getByRole("button", { name: /expand details/i });
        fireEvent.click(expandButton);
      });

      // Check for expanded content
      await waitFor(() => {
        expect(screen.getByText("Before Allocation")).toBeInTheDocument();
      });
    });

    it("should display before/after allocations in expanded view", async () => {
      const event = mockRebalanceEvent({
        beforeAllocation: [
          { protocol: "Blend", assetSymbol: "USDC", amount: 50000, percentage: 50 },
        ],
        afterAllocation: [
          { protocol: "Aave", assetSymbol: "USDC", amount: 100000, percentage: 100 },
        ],
      });

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [event],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      // Expand the event (click reveal button)
      await waitFor(() => {
        const expandButton = screen.getByRole("button", { name: /expand details/i });
        fireEvent.click(expandButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Before Allocation")).toBeInTheDocument();
        expect(screen.getByText("After Allocation")).toBeInTheDocument();
      });
    });

    it("should display risk notes in expanded view", async () => {
      const event = mockRebalanceEvent({
        riskNotes: [
          "High slippage expected",
          "Liquidity constraints may apply",
        ],
      });

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [event],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      // Expand the event
      await waitFor(() => {
        const expandButton = screen.getByRole("button", { name: /expand details/i });
        fireEvent.click(expandButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Risk Notes")).toBeInTheDocument();
        expect(screen.getByText(/High slippage expected/)).toBeInTheDocument();
      });
    });

    it("should display execution details when available", async () => {
      const event = mockRebalanceEvent({
        executionDetails: {
          gasCost: 2.5,
          slippagePercent: 0.1,
          actualGainUsd: 140,
        },
      });

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [event],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      // Expand the event
      await waitFor(() => {
        const expandButton = screen.getByRole("button", { name: /expand details/i });
        fireEvent.click(expandButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Execution Details")).toBeInTheDocument();
        expect(screen.getByText(/\$2.50/)).toBeInTheDocument();
      });
    });
  });

  describe("Error Handling", () => {
    it("should display error message on fetch failure", async () => {
      (RebalanceFeedService.fetchRecentRebalances as any).mockRejectedValue(
        new Error("Network error")
      );

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      await waitFor(() => {
        expect(
          screen.getByText(/Failed to load rebalance events/)
        ).toBeInTheDocument();
      });
    });

    it("should allow retry after error", async () => {
      const mockFetch = (RebalanceFeedService.fetchRecentRebalances as any);

      mockFetch.mockRejectedValueOnce(new Error("Network error"));
      mockFetch.mockResolvedValueOnce({
        vaultId: "vault-123",
        events: [mockRebalanceEvent()],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      // Initial error
      await waitFor(() => {
        expect(screen.getByText(/Failed to load rebalance events/)).toBeInTheDocument();
      });

      // Click refresh button
      const refreshButton = screen.getByRole("button", { name: "Refresh" });
      fireEvent.click(refreshButton);

      // Should load successfully after retry
      await waitFor(() => {
        expect(screen.getByText("Conservative Strategy")).toBeInTheDocument();
      });
    });
  });

  describe("Status Display", () => {
    it("should show 'Completed' status for completed rebalances", async () => {
      const event = mockRebalanceEvent({
        executionStatus: "completed",
      });

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [event],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      await waitFor(() => {
        expect(screen.getByText("Completed")).toBeInTheDocument();
      });
    });

    it("should show 'Pending' status for pending rebalances", async () => {
      const event = mockRebalanceEvent({
        executionStatus: "pending",
      });

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [event],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      await waitFor(() => {
        expect(screen.getByText("Pending")).toBeInTheDocument();
      });
    });

    it("should show 'Failed' status for failed rebalances", async () => {
      const event = mockRebalanceEvent({
        executionStatus: "failed",
      });

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [event],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      await waitFor(() => {
        expect(screen.getByText("Failed")).toBeInTheDocument();
      });
    });
  });

  describe("Polling and Real-Time Updates", () => {
    it("should start polling when enablePolling is true", async () => {
      const mockStartPolling = vi.fn(() => () => {});
      (RebalanceFeedService.startPolling as any) = mockStartPolling;

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [],
        timestamp: new Date().toISOString(),
      });

      render(
        <RebalanceFeed
          vaultId="vault-123"
          enablePolling={true}
          pollInterval={30000}
        />
      );

      await waitFor(() => {
        expect(mockStartPolling).toHaveBeenCalledWith(
          "vault-123",
          expect.any(Function),
          30000
        );
      });
    });

    it("should not poll when enablePolling is false", async () => {
      const mockStartPolling = vi.fn(() => () => {});
      (RebalanceFeedService.startPolling as any) = mockStartPolling;

      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [],
        timestamp: new Date().toISOString(),
      });

      render(
        <RebalanceFeed vaultId="vault-123" enablePolling={false} />
      );

      await waitFor(() => {
        expect(mockStartPolling).not.toHaveBeenCalled();
      });
    });
  });

  describe("Header and Metadata", () => {
    it("should display vault name in header", async () => {
      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [],
        timestamp: new Date().toISOString(),
      });

      render(
        <RebalanceFeed
          vaultId="vault-123"
          vaultName="My Custom Vault"
          enablePolling={false}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("My Custom Vault")).toBeInTheDocument();
      });
    });

    it("should display last updated timestamp", async () => {
      (RebalanceFeedService.fetchRecentRebalances as any).mockResolvedValue({
        vaultId: "vault-123",
        events: [],
        timestamp: new Date().toISOString(),
      });

      render(<RebalanceFeed vaultId="vault-123" enablePolling={false} />);

      await waitFor(() => {
        expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
      });
    });
  });
});
