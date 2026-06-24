import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SharePriceChart from "../SharePriceChart";

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
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeSnapshot(date: string, sharePrice: number) {
  return { date, sharePrice, vaultId: "primary-yield-vault" };
}

function deferred() {
  let resolve: (v: unknown) => void = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("SharePriceChart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state while data is fetched", async () => {
    const d = deferred();
    mockFetch.mockReturnValueOnce(d.promise);

    render(<SharePriceChart />);
    expect(screen.getByText(/Loading share price history/i)).toBeInTheDocument();

    d.resolve({ ok: true, json: async () => [] });
    await screen.findByText(/No share price snapshots available/i);
  });

  it("renders the chart when data is returned", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeSnapshot("2026-04-01", 1.0512),
        makeSnapshot("2026-04-02", 1.0525),
      ],
    });

    render(<SharePriceChart />);
    expect(await screen.findByTestId("line-chart")).toBeInTheDocument();
  });

  it("shows empty state when the API returns an empty array", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    render(<SharePriceChart />);
    expect(
      await screen.findByText(/No share price snapshots available/i),
    ).toBeInTheDocument();
  });

  it("shows error state on network failure and recovers after retry", async () => {
    const user = userEvent.setup();

    mockFetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [makeSnapshot("2026-04-01", 1.05)],
      });

    render(<SharePriceChart />);
    expect(
      await screen.findByText(/Unable to load share price history/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Retry/i }));
    expect(await screen.findByTestId("line-chart")).toBeInTheDocument();
  });

  it("shows error state on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    render(<SharePriceChart />);
    expect(
      await screen.findByText(/Unable to load share price history/i),
    ).toBeInTheDocument();
  });

  it("drops invalid snapshot rows instead of crashing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: "not-a-date", sharePrice: 1.05 },
        { date: null, sharePrice: 1.06 },
        { date: "2026-04-01", sharePrice: -1 },
        { date: "2026-04-02", sharePrice: 1.07 },
      ],
    });

    render(<SharePriceChart />);
    expect(await screen.findByTestId("line-chart")).toBeInTheDocument();
    expect(
      screen.queryByText(/No share price snapshots available/i),
    ).not.toBeInTheDocument();
  });

  it("renders range selector buttons", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    render(<SharePriceChart />);
    await screen.findByText(/No share price snapshots available/i);

    expect(screen.getByRole("button", { name: "1M" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3M" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
  });
});
