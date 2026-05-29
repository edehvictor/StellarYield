import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ApyDashboard from '../ApyDashboard';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function createDeferredResponse() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('ApyDashboard states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while APY data is being fetched', async () => {
    const deferred = createDeferredResponse();
    mockFetch.mockReturnValueOnce(deferred.promise);

    render(<ApyDashboard />);

    expect(screen.getByText(/Loading latest APY data/i)).toBeInTheDocument();

    deferred.resolve({
      ok: true,
      json: async () => [],
    });
    await screen.findByTestId('apy-empty-state');
  });

  it('renders APY cards when request succeeds', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          protocol: 'Blend',
          asset: 'USDC',
          apy: 8.42,
          tvl: 2450000,
          risk: 'Low',
          change24h: 0.32,
          rewardTokens: ['BLND'],
          category: 'Lending',
        },
      ],
    });

    render(<ApyDashboard />);

    const blendLabels = await screen.findAllByText('Blend');
    expect(blendLabels.length).toBeGreaterThan(0);
    expect(screen.getByText('USDC')).toBeInTheDocument();
    expect(screen.getByText('8.42')).toBeInTheDocument();
  });

  it('renders empty state when API returns no APY rows', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(<ApyDashboard />);

    expect(await screen.findByTestId('apy-empty-state')).toBeInTheDocument();
    expect(screen.getByText(/No APY data yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/New rates will appear here as protocols report yields/i),
    ).toBeInTheDocument();
  });

  it('shows retryable failure state and recovers on retry', async () => {
    const user = userEvent.setup();

    mockFetch
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            protocol: 'Soroswap',
            asset: 'XLM-USDC',
            apy: 14.75,
            tvl: 3100000,
            risk: 'Medium',
          },
        ],
      });

    render(<ApyDashboard />);

    expect(await screen.findByText(/Failed to Load APY Data/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/i }));

    const soroswapLabels = await screen.findAllByText('Soroswap');
    expect(soroswapLabels.length).toBeGreaterThan(0);
  });

  it('handles partial APY rows without breaking layout', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          apy: 'not-a-number',
          risk: 'Unknown',
          rewardTokens: [],
        },
      ],
    });

    render(<ApyDashboard />);

    const unknownProtocols = await screen.findAllByText('Unknown Protocol');
    expect(unknownProtocols.length).toBeGreaterThan(0);
    expect(screen.getByText('Unknown Asset')).toBeInTheDocument();
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  it('exposes accessible sort state, risk tooltips, and stale labels', async () => {
    const user = userEvent.setup();
    const fetchedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          protocol: 'Blend',
          asset: 'USDC',
          apy: 8.42,
          tvl: 2450000,
          risk: 'Low',
          change24h: 0.32,
          rewardTokens: ['BLND'],
          category: 'Lending',
          fetchedAt,
        },
      ],
    });

    render(<ApyDashboard />);

    expect(
      await screen.findByRole('button', { name: /Blend USDC risk: Low/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Stale data, \d+ minutes old/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Table/i }));

    expect(screen.getByRole('columnheader', { name: /APY/i })).toHaveAttribute(
      'aria-sort',
      'descending',
    );

    const tvlSort = screen.getByRole('button', { name: /^Sort by TVL$/i });
    expect(tvlSort).toHaveAttribute('aria-pressed', 'false');

    await user.click(tvlSort);

    expect(screen.getByRole('columnheader', { name: /TVL/i })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(
      screen.getByRole('button', { name: /Sort by TVL, currently descending/i }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
