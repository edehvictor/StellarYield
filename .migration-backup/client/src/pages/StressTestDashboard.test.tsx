import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import StressTestDashboard from "./StressTestDashboard";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("StressTestDashboard", () => {
  it("runs scenario and renders outputs", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        scenario: "apy-collapse",
        projectedFinalValueUsd: 9200,
        expectedLossUsd: 1800,
        expectedLossPct: 16.36,
        recoveryDaysEstimate: 55,
        exposureBreakdown: {
          yieldExposurePct: 70,
          liquidityExposurePct: 20,
          oracleExposurePct: 10,
        },
      }),
    });

    render(<StressTestDashboard />);

    fireEvent.click(screen.getByText("Run Scenario"));

    expect(await screen.findByText(/Projected final value/i)).toBeInTheDocument();
    expect(await screen.findByText(/Expected loss/i)).toBeInTheDocument();
    expect(await screen.findByText(/Exposure breakdown/i)).toBeInTheDocument();
  });
});
