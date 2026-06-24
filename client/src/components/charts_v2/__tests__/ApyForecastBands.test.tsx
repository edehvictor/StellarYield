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
  Line: ({ dataKey }: { dataKey: string }) => (
    <div data-testid={`line-${dataKey}`} />
  ),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const MOCK_HISTORICAL = [
  { date: "2026-05-19", apy: 6.2 },
  { date: "2026-05-20", apy: 6.4 },
  { date: "2026-05-21", apy: 6.5 },
];

const MOCK_PREDICTIONS = [
  { date: "2026-05-22", predictedApy: 6.6, lowerApy: 6.1, upperApy: 7.1, confidence: 0.85 },
  { date: "2026-05-23", predictedApy: 6.7, lowerApy: 6.0, upperApy: 7.4, confidence: 0.75 },
];

describe("ApyHistoryChart confidence band rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the chart with historical and forecast data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ historical: MOCK_HISTORICAL, predictions: MOCK_PREDICTIONS }),
    });

    render(<ApyHistoryChart />);
    expect(await screen.findByTestId("line-chart")).toBeInTheDocument();
  });

  it("renders the predictedApy line (median forecast band)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ historical: MOCK_HISTORICAL, predictions: MOCK_PREDICTIONS }),
    });

    render(<ApyHistoryChart />);
    await screen.findByTestId("line-chart");
    expect(screen.getByTestId("line-predictedApy")).toBeInTheDocument();
  });

  it("renders the lowerApy confidence band line", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ historical: MOCK_HISTORICAL, predictions: MOCK_PREDICTIONS }),
    });

    render(<ApyHistoryChart />);
    await screen.findByTestId("line-chart");
    expect(screen.getByTestId("line-lowerApy")).toBeInTheDocument();
  });

  it("renders the upperApy confidence band line", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ historical: MOCK_HISTORICAL, predictions: MOCK_PREDICTIONS }),
    });

    render(<ApyHistoryChart />);
    await screen.findByTestId("line-chart");
    expect(screen.getByTestId("line-upperApy")).toBeInTheDocument();
  });

  it("renders the historical apy line", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ historical: MOCK_HISTORICAL, predictions: MOCK_PREDICTIONS }),
    });

    render(<ApyHistoryChart />);
    await screen.findByTestId("line-chart");
    expect(screen.getByTestId("line-apy")).toBeInTheDocument();
  });

  it("shows the APY Forecast heading", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ historical: MOCK_HISTORICAL, predictions: MOCK_PREDICTIONS }),
    });

    render(<ApyHistoryChart />);
    expect(await screen.findByText("APY Forecast")).toBeInTheDocument();
  });

  it("shows uncertainty description text", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ historical: MOCK_HISTORICAL, predictions: MOCK_PREDICTIONS }),
    });

    render(<ApyHistoryChart />);
    expect(await screen.findByText(/uncertainty/i)).toBeInTheDocument();
  });

  it("shows error state when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("API down"));

    render(<ApyHistoryChart />);
    expect(await screen.findByText(/Unable to load APY forecast/i)).toBeInTheDocument();
  });

  it("shows loading state initially", () => {
    const deferred = { resolve: (_: unknown) => {} };
    const promise = new Promise((res) => { deferred.resolve = res; });
    mockFetch.mockReturnValueOnce(promise);

    render(<ApyHistoryChart />);
    expect(screen.getByText(/Loading APY forecast/i)).toBeInTheDocument();

    deferred.resolve({ ok: true, json: async () => ({ historical: [], predictions: [] }) });
  });
});
