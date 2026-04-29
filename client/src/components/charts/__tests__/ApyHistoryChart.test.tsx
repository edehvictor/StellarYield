import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ApyHistoryChart from '../ApyHistoryChart';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div data-testid="chart-container">{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div data-testid="line-chart">{children}</div>,
  CartesianGrid: () => <div data-testid="grid" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  Tooltip: () => <div data-testid="tooltip" />,
  Line: () => <div data-testid="line" />,
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

function createDeferredResponse() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('ApyHistoryChart states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while history is being fetched', async () => {
    const deferred = createDeferredResponse();
    mockFetch.mockReturnValueOnce(deferred.promise);

    render(<ApyHistoryChart />);

    expect(screen.getByText(/Loading APY history/i)).toBeInTheDocument();

    deferred.resolve({
      ok: true,
      json: async () => [],
    });
    await screen.findByText(/No APY history points available/i);
  });

  it('renders chart on successful response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ date: '2026-04-25', apy: 8.4 }],
    });

    render(<ApyHistoryChart />);

    expect(await screen.findByTestId('line-chart')).toBeInTheDocument();
  });

  it('shows empty state for valid but empty history payload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(<ApyHistoryChart />);

    expect(await screen.findByText(/No APY history points available/i)).toBeInTheDocument();
  });

  it('shows retryable error state and recovers after retry', async () => {
    const user = userEvent.setup();

    mockFetch
      .mockRejectedValueOnce(new Error('History API down'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ date: '2026-04-25', apy: 8.4 }],
      });

    render(<ApyHistoryChart />);

    expect(await screen.findByText(/Unable to load APY history/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/i }));

    expect(await screen.findByTestId('line-chart')).toBeInTheDocument();
  });

  it('handles partial history data by dropping invalid rows', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: 'invalid-date', apy: 8.1 },
        { date: '2026-04-20', apy: '9.2' },
        { date: null, apy: 10.1 },
      ],
    });

    render(<ApyHistoryChart />);

    expect(await screen.findByTestId('line-chart')).toBeInTheDocument();
    expect(screen.queryByText(/No APY history points available/i)).not.toBeInTheDocument();
  });
});
