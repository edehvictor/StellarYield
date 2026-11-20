import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import RiskScoreBreakdownPanel from "./RiskScoreBreakdownPanel";

/** Coverage for the per-widget retry action added for issue #1151. */

describe("RiskScoreBreakdownPanel retry (#1151)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a retry action on failure and re-fetches on click", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          snapshots: [
            {
              regime: "balanced",
              portfolioRiskScore: 4.2,
              label: "Medium",
              breakdown: { tvl: 1, volatility: 1, age: 1 },
              weights: { tvl: 0.4, volatility: 0.3, age: 0.3 },
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<RiskScoreBreakdownPanel />);

    const errorBox = await screen.findByTestId("risk-breakdown-error");
    expect(errorBox).toHaveTextContent(/Server returned 500/);

    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => expect(screen.getByText(/Balanced/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders resolved snapshots when the fetch succeeds on the first try", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          snapshots: [
            {
              regime: "extreme",
              portfolioRiskScore: 9.1,
              label: "High",
              breakdown: { tvl: 3, volatility: 5, age: 1 },
              weights: { tvl: 0.4, volatility: 0.3, age: 0.3 },
            },
          ],
        }),
      }),
    );

    render(<RiskScoreBreakdownPanel />);

    expect(await screen.findByText(/Extreme/)).toBeInTheDocument();
    expect(screen.queryByTestId("risk-breakdown-error")).not.toBeInTheDocument();
  });
});
