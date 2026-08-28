/**
 * ApyHistoryStaleIndicators.test.tsx — Issue #1005 (charts_v2)
 *
 * Mirrors charts/__tests__/ApyHistoryStaleIndicators.test.tsx for the v2 chart component.
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

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

describe("ApyHistoryChart v2 — stale-data indicators (#1005)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fresh data → no stale banner, chart renders", async () => {
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
  });

  it("all data stale → all-stale empty state shown, chart hidden", async () => {
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
  });

  it("mixed freshness → partial stale banner shown, chart still renders", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: "2026-06-01", apy: 7.0, fetchedAt: minutesAgo(60) },
        { date: "2026-06-02", apy: 8.0, fetchedAt: minutesAgo(1) },
        { date: "2026-06-03", apy: 9.0, fetchedAt: minutesAgo(1) },
      ],
    });

    render(<ApyHistoryChart />);

    expect(await screen.findByTestId("line-chart")).toBeInTheDocument();
    expect(screen.getByTestId("apy-history-partial-stale-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-all-stale-empty")).not.toBeInTheDocument();
  });

  it("no fetchedAt → treated as fresh, no stale indicators", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: "2026-06-01", apy: 8.0 },
        { date: "2026-06-02", apy: 8.5 },
      ],
    });

    render(<ApyHistoryChart />);

    expect(await screen.findByTestId("line-chart")).toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-all-stale-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("apy-history-partial-stale-banner")).not.toBeInTheDocument();
  });

  it("stale reference lines rendered for each stale point", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: "2026-06-01", apy: 7.0, fetchedAt: minutesAgo(60) },
        { date: "2026-06-02", apy: 8.0, fetchedAt: minutesAgo(1) },
        { date: "2026-06-03", apy: 7.5, fetchedAt: minutesAgo(60) },
      ],
    });

    render(<ApyHistoryChart />);

    await screen.findByTestId("line-chart");
    const refLines = screen.getAllByTestId("stale-reference-line");
    expect(refLines).toHaveLength(2);
  });
});
