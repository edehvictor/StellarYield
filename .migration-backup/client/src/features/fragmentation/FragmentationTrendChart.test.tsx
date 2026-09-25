import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import FragmentationTrendChart from "./FragmentationTrendChart";

const mockFetch = vi.fn();
global.fetch = mockFetch;

function createMockHistory(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const snapshots = [];
  for (let i = 29; i >= 0; i--) {
    snapshots.push({
      timestamp: new Date(now - i * 24 * 60 * 60 * 1000).toISOString(),
      fragmentationScore: 45 + (i % 5) * 1.5,
      effectiveProtocolCount: 1.82 + (i % 7) * 0.1,
      hhi: 5480,
      multiProtocolRoutingPct: 35.7,
      executionQualityScore: 72.3,
    });
  }

  return {
    success: true,
    data: {
      snapshots,
      source: "mock",
      dataFreshness: {
        earliestSnapshot: snapshots[0].timestamp,
        latestSnapshot: snapshots[snapshots.length - 1].timestamp,
        snapshotCount: snapshots.length,
      },
      ...overrides,
    },
  };
}

describe("FragmentationTrendChart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading state initially", () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));
    render(<FragmentationTrendChart />);
    expect(screen.getByText("Loading historical data...")).toBeInTheDocument();
  });

  it("renders chart with data when fetch succeeds", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => createMockHistory(),
    });

    render(<FragmentationTrendChart />);

    await waitFor(() => {
      expect(screen.getByText("Historical Trends")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText(/30 snapshots over 30 days/)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByRole("img", { name: /trend chart/i })).toBeInTheDocument();
    });
  });

  it("shows summary statistics", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => createMockHistory(),
    });

    render(<FragmentationTrendChart />);

    await waitFor(() => {
      expect(screen.getByText("Latest")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Average")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Change")).toBeInTheDocument();
    });
  });

  it("switches metrics when button is clicked", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => createMockHistory(),
    });

    render(<FragmentationTrendChart />);

    await waitFor(() => {
      expect(screen.getByText("Fragmentation")).toBeInTheDocument();
    });

    const protocolsBtn = screen.getByText("Effective");
    await userEvent.click(protocolsBtn);

    await waitFor(() => {
      expect(screen.getByRole("img", { name: /Effective Protocols/ })).toBeInTheDocument();
    });
  });

  it("displays error state on fetch failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        success: false,
        error: { code: "HISTORY_UNAVAILABLE", message: "No historical data" },
      }),
    });

    render(<FragmentationTrendChart />);

    await waitFor(() => {
      expect(screen.getByText("Error Loading History")).toBeInTheDocument();
    });
  });

  it("shows mock data warnings when present", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        createMockHistory({
          warnings: ["Historical data based on simulated projections"],
        }),
    });

    render(<FragmentationTrendChart />);

    await waitFor(() => {
      expect(
        screen.getByText(/Historical data based on simulated projections/),
      ).toBeInTheDocument();
    });
  });

  it("shows empty state when no snapshots", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          snapshots: [],
          source: "mock",
          dataFreshness: {
            earliestSnapshot: new Date().toISOString(),
            latestSnapshot: new Date().toISOString(),
            snapshotCount: 0,
          },
        },
      }),
    });

    render(<FragmentationTrendChart />);

    await waitFor(() => {
      expect(screen.getByText("No historical data available")).toBeInTheDocument();
    });
  });

  it("includes data source in footer", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => createMockHistory(),
    });

    render(<FragmentationTrendChart />);

    await waitFor(() => {
      expect(screen.getByText(/Source:/)).toBeInTheDocument();
    });
  });

  it("renders data freshness date range", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => createMockHistory(),
    });

    render(<FragmentationTrendChart />);

    await waitFor(() => {
      const freshnessElements = screen.getAllByText(/2025|2026/);
      expect(freshnessElements.length).toBeGreaterThan(0);
    });
  });
});
