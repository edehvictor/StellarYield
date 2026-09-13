import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi } from "vitest";
import { DepositSimulator } from "./DepositSimulator";
import { fetchDepositSimulation } from "./simulationService";

vi.mock("./simulationService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./simulationService")>();
  return {
    ...actual,
    fetchDepositSimulation: vi.fn(),
  };
});

const mockFetch = fetchDepositSimulation as any;

describe("DepositSimulator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should display a prompt when amount is 0", () => {
    render(<DepositSimulator strategyId="Conservative" amount={0} token="USDC" />);
    expect(screen.getByText(/Enter an amount to see the preview/i)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should render preview details on successful simulation", async () => {
    mockFetch.mockResolvedValueOnce({
      isSimulationOnly: true,
      allocations: [{ protocol: "Lend", amount: 1000, percentage: 100 }],
      expectedShares: 999,
      fees: [{ type: "Entry Fee", amount: 1 }],
      postDepositExposure: { expectedApy: 0.12 },
      routing: { path: ["Lend"], expectedOutput: 999 },
      warnings: [],
    });

    render(<DepositSimulator strategyId="Conservative" amount={1000} token="USDC" />);
    
    expect(screen.getByText(/Running simulation/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("PREVIEW ONLY")).toBeInTheDocument();
    });

    expect(screen.getByText("Expected Shares")).toBeInTheDocument();
    expect(screen.getByText("999")).toBeInTheDocument();
    expect(screen.getByText("12.00%")).toBeInTheDocument();
    expect(screen.getByText("Lend")).toBeInTheDocument();
    expect(screen.getByText("Entry Fee")).toBeInTheDocument();
  });

  it("should render warnings when present", async () => {
    mockFetch.mockResolvedValueOnce({
      isSimulationOnly: true,
      allocations: [],
      expectedShares: 0,
      fees: [],
      postDepositExposure: { expectedApy: 0 },
      routing: { path: [], expectedOutput: 0 },
      warnings: ["High slippage expected"],
    });

    render(<DepositSimulator strategyId="Conservative" amount={150000} token="USDC" />);
    
    await waitFor(() => {
      expect(screen.getByText("Warnings")).toBeInTheDocument();
    });

    expect(screen.getByText("High slippage expected")).toBeInTheDocument();
  });

  it("should render error state if fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network Error"));

    render(<DepositSimulator strategyId="Conservative" amount={1000} token="USDC" />);
    
    await waitFor(() => {
      expect(screen.getByText(/Error: Network Error/i)).toBeInTheDocument();
    });
  });

  it("should discard stale out-of-order responses and render only latest amount result", async () => {
    mockFetch.mockImplementation(async (params: any) => {
      if (params.amount === 100) {
        // Slower response for older amount 100
        await new Promise((r) => setTimeout(r, 200));
        return {
          isSimulationOnly: true,
          allocations: [{ protocol: "Lend", amount: 100, percentage: 100 }],
          expectedShares: 100,
          fees: [],
          postDepositExposure: { expectedApy: 0.05 },
          routing: { path: ["Lend"], expectedOutput: 100 },
          warnings: [],
        };
      } else {
        // Faster response for newer amount 500
        return {
          isSimulationOnly: true,
          allocations: [{ protocol: "Lend", amount: 500, percentage: 100 }],
          expectedShares: 500,
          fees: [],
          postDepositExposure: { expectedApy: 0.10 },
          routing: { path: ["Lend"], expectedOutput: 500 },
          warnings: [],
        };
      }
    });

    const { rerender } = render(
      <DepositSimulator strategyId="Conservative" amount={100} token="USDC" />
    );

    // Rapidly edit amount to 500
    rerender(<DepositSimulator strategyId="Conservative" amount={500} token="USDC" />);

    await waitFor(() => {
      expect(screen.getByText("500")).toBeInTheDocument();
    });

    // Make sure stale 100 result was not rendered
    expect(screen.queryByText("100")).not.toBeInTheDocument();
  });
});

