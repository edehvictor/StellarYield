import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import UnifiedActivityTimeline from "./UnifiedActivityTimeline";

const mockFetch = vi.fn();

describe("UnifiedActivityTimeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("renders an empty state when the timeline has no events", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ timeline: [] }),
    });

    render(<UnifiedActivityTimeline walletAddress="GTESTWALLET" />);

    expect(await screen.findByText("No activity found for this view.")).toBeTruthy();
  });

  it("renders mixed timeline events grouped by date", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        timeline: [
          {
            id: "event-1",
            walletAddress: "GTESTWALLET",
            type: "deposit",
            title: "Deposited USDC into Blend Stable",
            description: "Capital routed into Blend Stable for yield capture.",
            timestamp: "2026-05-26T08:15:00.000Z",
            source: "portfolio",
            amountUsd: 5000,
            assetSymbol: "USDC",
          },
          {
            id: "event-2",
            walletAddress: "GTESTWALLET",
            type: "reward",
            title: "Reward accrued from Yield Index",
            description: "Claimable YIELD rewards were refreshed for this position.",
            timestamp: "2026-05-26T06:30:00.000Z",
            source: "rewards",
            amountUsd: 84.5,
            assetSymbol: "YIELD",
          },
          {
            id: "event-3",
            walletAddress: "GTESTWALLET",
            type: "alert",
            title: "Watch alert for Yield Index",
            description: "Freshness lag exceeded 12 hours",
            timestamp: "2026-05-25T11:00:00.000Z",
            source: "monitoring",
            severity: "critical",
          },
        ],
      }),
    });

    render(<UnifiedActivityTimeline walletAddress="GTESTWALLET" />);

    expect(await screen.findByText("Deposited USDC into Blend Stable")).toBeTruthy();
    expect(screen.getByText("Reward accrued from Yield Index")).toBeTruthy();
    expect(screen.getByText("Watch alert for Yield Index")).toBeTruthy();
    expect(screen.getByText("Monday, May 25, 2026")).toBeTruthy();
    expect(screen.getByText("Tuesday, May 26, 2026")).toBeTruthy();
  });

  it("requests a filtered timeline when a filter is toggled", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          timeline: [
            {
              id: "event-1",
              walletAddress: "GTESTWALLET",
              type: "deposit",
              title: "Deposited USDC into Blend Stable",
              description: "Capital routed into Blend Stable for yield capture.",
              timestamp: "2026-05-26T08:15:00.000Z",
              source: "portfolio",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          timeline: [
            {
              id: "event-2",
              walletAddress: "GTESTWALLET",
              type: "reward",
              title: "Reward accrued from Yield Index",
              description: "Claimable YIELD rewards were refreshed for this position.",
              timestamp: "2026-05-26T06:30:00.000Z",
              source: "rewards",
            },
          ],
        }),
      });

    render(<UnifiedActivityTimeline walletAddress="GTESTWALLET" />);

    expect(await screen.findByText("Deposited USDC into Blend Stable")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rewards" }));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.stringContaining("types=reward"),
      ),
    );
    expect(await screen.findByText("Reward accrued from Yield Index")).toBeTruthy();
  });
});
