import { render, screen, waitFor } from "@testing-library/react";
import CorrelationHeatmap from "./CorrelationHeatmap";
import { apiUrl } from "../../lib/api";
import { describe, it, expect, vi, afterEach } from "vitest";

global.fetch = vi.fn();

describe("CorrelationHeatmap", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const mockData = {
    items: ["Blend", "Soroswap"],
    matrix: [
      [1, 0.8],
      [0.8, 1],
    ],
    warnings: ["High correlation detected between Blend and Soroswap (80.0%)"],
  };

  it("renders loading state initially", () => {
    (global.fetch as any).mockImplementation(() => new Promise(() => {})); // Never resolves
    const { container } = render(<CorrelationHeatmap />);
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("fetches and renders matrix data", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    });

    render(<CorrelationHeatmap />);

    await waitFor(() => {
      expect(screen.getByText("Asset Correlation Matrix")).toBeInTheDocument();
    });

    // Check row/column headers
    expect(screen.getAllByText("Blend").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Soroswap").length).toBeGreaterThan(0);

    // Check cells based on rounded value
    expect(screen.getAllByText("1.00").length).toBe(2);
    expect(screen.getAllByText("0.80").length).toBe(2);
  });

  it("surfaces concentration warnings when present", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    });

    render(<CorrelationHeatmap />);

    await waitFor(() => {
      expect(screen.getByTestId("concentration-warnings")).toBeInTheDocument();
    });

    expect(screen.getByText(/High correlation detected between/i)).toBeInTheDocument();
  });

  it("handles fetch error gracefully", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
    });

    render(<CorrelationHeatmap />);

    await waitFor(() => {
      expect(screen.getByText(/Unable to fetch correlation data/i)).toBeInTheDocument();
    });
  });
});
