import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BasketRebalancePreviewPanel from "./BasketRebalancePreviewPanel";

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as Response);
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("BasketRebalancePreviewPanel", () => {
  it("renders before/after weight rows on a successful preview", async () => {
    mockFetch.mockReturnValue(
      jsonResponse({
        contractId: "C1",
        totalDeposited: "1000000",
        legs: [
          {
            tokenContractId: "CTOKENA00000000",
            currentWeightBps: 7000,
            targetWeightBps: 6000,
            driftBps: 1000,
            deltaAmount: "-100000",
            isEstimated: false,
          },
        ],
        rebalanceNeeded: true,
        source: "onchain",
        warnings: [],
      })
    );

    render(<BasketRebalancePreviewPanel contractId="C1" />);
    fireEvent.click(screen.getByText("Preview rebalance"));

    await waitFor(() => expect(screen.getByText("60.00%")).toBeDefined());
    expect(screen.getByText("70.00%")).toBeDefined();
  });

  it("shows a safe fallback banner when basket data is unavailable", async () => {
    mockFetch.mockReturnValue(
      jsonResponse({
        contractId: "C1",
        totalDeposited: "0",
        legs: [],
        rebalanceNeeded: false,
        source: "unavailable",
        warnings: ["Basket data is currently unavailable; showing no preview."],
      })
    );

    render(<BasketRebalancePreviewPanel contractId="C1" />);
    fireEvent.click(screen.getByText("Preview rebalance"));

    await waitFor(() =>
      expect(screen.getByText(/Basket data is currently unavailable/)).toBeDefined()
    );
  });

  it("blocks submission by flagging an invalid target weight sum", async () => {
    mockFetch.mockReturnValue(
      jsonResponse({
        contractId: "C1",
        totalDeposited: "1000000",
        legs: [
          {
            tokenContractId: "CTOKENA",
            currentWeightBps: 5000,
            targetWeightBps: 5000,
            driftBps: 0,
            deltaAmount: "0",
            isEstimated: true,
          },
          {
            tokenContractId: "CTOKENB",
            currentWeightBps: 4000,
            targetWeightBps: 4000,
            driftBps: 0,
            deltaAmount: "0",
            isEstimated: true,
          },
        ],
        rebalanceNeeded: false,
        source: "onchain",
        warnings: [],
      })
    );

    render(<BasketRebalancePreviewPanel contractId="C1" />);
    fireEvent.click(screen.getByText("Preview rebalance"));

    await waitFor(() => expect(screen.getByText(/not 100%/)).toBeDefined());
  });
});
