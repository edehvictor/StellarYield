/**
 * ApyHistoryStaleIndicators.test.tsx — Issue #1005
 *
 * Tests for stale-data indicators in ApyHistoryChart:
 *
 * 1. Recent data (fresh fetchedAt) → no stale banner shown.
 * 2. All data stale beyond threshold → all-stale empty state shown.
 * 3. Mixed data (some stale, some fresh) → partial stale banner shown.
 * 4. fetchedAt missing → treated as fresh (no stale indicator).
 * 5. Chart renders normally alongside partial stale banner (not hidden).
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ApyHistoryChart from "../ApyHistoryChart";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="chart-container">{children}</div>
  ),
  LineChart: ({ children }: { children: ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  CartesianGrid: () => <div data-testid="grid" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  Tooltip: () => <div data-testid="tooltip" />,
  Line: () => <div data-testid="line" />,
  ReferenceLine: ({ x }: { x: string }) => (
    <div data-testid="stale-reference-line" data-date={x} />
  ),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

/** Returns an ISO timestamp that is `minutesAgo` minutes in the past. */
function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

describe("ApyHistoryChart — stale-data indicators (#1005)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. fresh data (recent fetchedAt) → no stale banner shown, chart renders", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: "2026-06-01", apy: 8.0, fetchedAt: minutesAgo(1) },
        { date: "2026-06-02", apy: 8.5, fetchedAt: minutesAgo(2) },
      ],
    });

    render(<ApyHistoryChart />);

    expect(await screen.findByTestId("line-chart")).toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-all-stale-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-partial-stale-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-all-stale-empty")).not.toBeInTheDocument();
  });

  it("2. all data stale → all-stale empty state shown instead of chart", async () => {
    // fetchedAt is 60 minutes ago → well beyond the 5-minute stale threshold
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: "2026-06-01", apy: 8.0, fetchedAt: minutesAgo(60) },
        { date: "2026-06-02", apy: 8.5, fetchedAt: minutesAgo(60) },
      ],
    });

    render(<ApyHistoryChart />);

    expect(await screen.findByTestId("apy-history-all-stale-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("line-chart")).not.toBeInTheDocument();
    expect(screen.queryByText(/No APY history points available/i)).not.toBeInTheDocument();
  });

  it("3. mixed freshness → partial stale banner shown alongside chart", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: "2026-06-01", apy: 7.0, fetchedAt: minutesAgo(60) }, // stale
        { date: "2026-06-02", apy: 8.0, fetchedAt: minutesAgo(1) },  // fresh
        { date: "2026-06-03", apy: 9.0, fetchedAt: minutesAgo(2) },  // fresh
      ],
    });

    render(<ApyHistoryChart />);

    // Chart should still render
    expect(await screen.findByTestId("line-chart")).toBeInTheDocument();
    // Partial stale banner should appear
    expect(screen.getByTestId("apy-history-partial-stale-banner")).toBeInTheDocument();
    // All-stale states should NOT appear
    expect(screen.queryByTestId("apy-history-all-stale-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-all-stale-empty")).not.toBeInTheDocument();
  });

  it("4. fetchedAt missing → treated as fresh, no stale indicator", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: "2026-06-01", apy: 8.0 },  // no fetchedAt
        { date: "2026-06-02", apy: 8.5 },  // no fetchedAt
      ],
    });

    render(<ApyHistoryChart />);

    expect(await screen.findByTestId("line-chart")).toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-all-stale-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-partial-stale-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-all-stale-empty")).not.toBeInTheDocument();
  });

  it("5. partial stale banner includes stale count and total point count", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: "2026-06-01", apy: 6.0, fetchedAt: minutesAgo(60) }, // stale
        { date: "2026-06-02", apy: 7.0, fetchedAt: minutesAgo(1) },  // fresh
        { date: "2026-06-03", apy: 8.0, fetchedAt: minutesAgo(1) },  // fresh
      ],
    });

    render(<ApyHistoryChart />);

    const banner = await screen.findByTestId("apy-history-partial-stale-banner");
    expect(banner).toBeInTheDocument();
    // Banner text should mention 1 stale out of 3 points
    expect(banner.textContent).toMatch(/1 of 3/);
  });

  it("6. stale reference lines rendered for each stale point", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: "2026-06-01", apy: 7.0, fetchedAt: minutesAgo(60) }, // stale
        { date: "2026-06-02", apy: 8.0, fetchedAt: minutesAgo(1) },  // fresh
        { date: "2026-06-03", apy: 7.5, fetchedAt: minutesAgo(60) }, // stale
      ],
    });

    render(<ApyHistoryChart />);

    await screen.findByTestId("line-chart");
    const refLines = screen.getAllByTestId("stale-reference-line");
    expect(refLines).toHaveLength(2);
    expect(refLines[0]).toHaveAttribute("data-date", "2026-06-01");
    expect(refLines[1]).toHaveAttribute("data-date", "2026-06-03");
  });

  it("7. empty API response still shows empty state, not stale state", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(<ApyHistoryChart />);

    expect(await screen.findByText(/No APY history points available/i)).toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-all-stale-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-all-stale-banner")).not.toBeInTheDocument();
  });

  it("8. HTTP error → error UI shown, not stale UI", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    render(<ApyHistoryChart />);

    expect(await screen.findByText(/Unable to load APY history/i)).toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-all-stale-empty")).not.toBeInTheDocument();
  });
});
