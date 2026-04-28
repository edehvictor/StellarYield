import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import AIAdvisor from "../AIAdvisor";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("AIAdvisor timeline", () => {
  it("renders risk explanations for low, medium, and high levels", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ timeline: [] }),
    });

    render(<AIAdvisor />);

    expect(await screen.findByText(/High Risk/i)).toBeInTheDocument();
    expect(screen.getByText(/Medium Risk/i)).toBeInTheDocument();
    expect(screen.getByText(/Low Risk/i)).toBeInTheDocument();
    expect(screen.getByText(/stale data signals/i)).toBeInTheDocument();
    expect(screen.getByText(/acceptable data freshness/i)).toBeInTheDocument();
    expect(screen.getByText(/consistently fresh data/i)).toBeInTheDocument();
  });

  it("renders recommendation history entries", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        timeline: [
          {
            id: "1",
            recommendation: "Move to Blend stable vault.",
            rationale: "Lower volatility and better liquidity.",
            targetVault: "Blend Stable",
            changedInputs: ["volatilityPct", "expectedApy"],
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    render(<AIAdvisor />);

    expect(await screen.findByText("Recommendation Timeline")).toBeInTheDocument();
    expect(await screen.findByText("Blend Stable")).toBeInTheDocument();
    expect(await screen.findByText(/Changed inputs:/i)).toBeInTheDocument();
  });
});
