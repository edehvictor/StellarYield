import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DepositRecommendationWizard from "../AIAdvisor/DepositRecommendationWizard";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockRecommendations = {
  summary: "For a balanced investor, we recommend Blend first.",
  recommendation: "Based on your balanced risk tolerance, we recommend Blend.",
  recommendations: [
    {
      rank: 1,
      id: "blend",
      name: "Blend",
      apy: 8.5,
      riskScore: 8,
      riskAdjustedYield: 6.2,
      tvlUsd: 10_000_000,
      ilVolatilityPct: 3,
      explanation: "Ranked #1 with risk-adjusted yield of 6.20%. Balances yield with moderate volatility.",
      matchScore: 12.5,
    },
  ],
};

describe("DepositRecommendationWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => mockRecommendations,
    });
  });

  it("walks through wizard steps and shows ranked recommendations", async () => {
    render(<DepositRecommendationWizard />);

    expect(screen.getByTestId("deposit-wizard")).toBeInTheDocument();
    expect(screen.getByText("Risk Tolerance")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Conservative"));
    fireEvent.click(screen.getByText(/Next/));

    expect(screen.getByText(/investment time horizon/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Medium (3–12 months)"));
    fireEvent.click(screen.getByText(/Next/));

    expect(screen.getByText(/How important is liquidity/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText("High"));
    fireEvent.click(screen.getByText(/Get Recommendations/));

    await waitFor(() => {
      expect(screen.getByTestId("vault-rec-blend")).toBeInTheDocument();
    });

    expect(screen.getByText(/Ranked #1/)).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/recommend"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("conservative"),
      }),
    );
  });
});
