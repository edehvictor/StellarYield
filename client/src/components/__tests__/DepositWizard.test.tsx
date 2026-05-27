import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DepositWizard from "../AIAdvisor/DepositWizard";

const mockRecommendations = (profile: string) => ({
  profile,
  timeHorizon: "medium",
  liquidity: "medium",
  recommendations: [
    {
      rank: 1,
      id: "blend",
      name: "Blend USDC Vault",
      strategyType: "blend",
      apy: 8.5,
      tvlUsd: 2500000,
      riskScore: 8,
      riskAdjustedYield: 0.72,
      ilVolatilityPct: 3,
      explanation: `Ranked #1 for a ${profile} profile.`,
    },
  ],
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockRecommendations("balanced"),
    }),
  );
});

describe("DepositWizard", () => {
  it("renders step 1 with risk tolerance options", () => {
    render(<DepositWizard />);
    expect(screen.getByText("Risk Tolerance")).toBeInTheDocument();
    expect(screen.getByText("Conservative")).toBeInTheDocument();
    expect(screen.getByText("Balanced")).toBeInTheDocument();
    expect(screen.getByText("Aggressive")).toBeInTheDocument();
  });

  it("advances to step 2 on Next click", () => {
    render(<DepositWizard />);
    fireEvent.click(screen.getByText(/Next/i));
    expect(screen.getByText("Time Horizon")).toBeInTheDocument();
  });

  it("advances to step 3 on second Next click", () => {
    render(<DepositWizard />);
    fireEvent.click(screen.getByText(/Next/i));
    fireEvent.click(screen.getByText(/Next/i));
    expect(screen.getByText("Liquidity Needs")).toBeInTheDocument();
  });

  it("calls the wizard API and shows recommendations", async () => {
    render(<DepositWizard />);
    fireEvent.click(screen.getByText(/Next/i));
    fireEvent.click(screen.getByText(/Next/i));
    fireEvent.click(screen.getByText(/Get Recommendations/i));

    await waitFor(() => {
      expect(screen.getByText("Top Vault Recommendations")).toBeInTheDocument();
    });
    expect(screen.getByText("Blend USDC Vault")).toBeInTheDocument();
  });

  it("shows an error message when the API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    render(<DepositWizard />);
    fireEvent.click(screen.getByText(/Next/i));
    fireEvent.click(screen.getByText(/Next/i));
    fireEvent.click(screen.getByText(/Get Recommendations/i));

    await waitFor(() => {
      expect(screen.getByText(/Server error 500/i)).toBeInTheDocument();
    });
  });

  it("can restart the wizard from the results view", async () => {
    render(<DepositWizard />);
    fireEvent.click(screen.getByText(/Next/i));
    fireEvent.click(screen.getByText(/Next/i));
    fireEvent.click(screen.getByText(/Get Recommendations/i));

    await waitFor(() => screen.getByText("Top Vault Recommendations"));
    fireEvent.click(screen.getByText("Start over"));
    expect(screen.getByText("Risk Tolerance")).toBeInTheDocument();
  });
});
