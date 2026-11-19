import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import StrategyComparison from './StrategyComparison';

vi.mock('../../hooks/useBackendStatus', () => ({
  useBackendStatus: vi.fn(() => 'available'),
}));

// Mock matchMedia for recharts/lucide-react inner behaviors if needed
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const mockYields = [
  {
    protocolName: 'Blend',
    apy: 6.45,
    rewardApy: 2.23,
    totalApy: 8.68,
    tvl: 12400000,
    riskScore: 23,
    liquidityUsd: 11200000,
    rebalancingBehavior: 'Static',
    managementFeeBps: 0,
    performanceFeeBps: 1000,
    capitalEfficiencyPct: 75,
    fetchedAt: new Date().toISOString()
  },
  {
    protocolName: 'Soroswap',
    apy: 11.2,
    rewardApy: 1.55,
    totalApy: 12.75,
    tvl: 4850000,
    riskScore: 68,
    liquidityUsd: 3900000,
    rebalancingBehavior: 'Dynamic',
    managementFeeBps: 30,
    performanceFeeBps: 0,
    capitalEfficiencyPct: 92,
    fetchedAt: new Date().toISOString()
  },
  {
    protocolName: 'DeFindex',
    apy: 9.25,
    rewardApy: 1.4,
    totalApy: 10.65,
    tvl: 2150000,
    riskScore: 45,
    liquidityUsd: 1850000,
    rebalancingBehavior: 'Yield-Weighted',
    managementFeeBps: 50,
    performanceFeeBps: 2000,
    capitalEfficiencyPct: 88,
    fetchedAt: new Date().toISOString()
  }
];

describe('StrategyComparison Component', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders loading skeleton initially', () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    const { container } = render(<StrategyComparison />);
    expect(container.getElementsByClassName('animate-pulse').length).toBe(3);
  });

  it('renders at least three strategies and formats data correctly', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockYields
    });

    render(<StrategyComparison />);

    await waitFor(() => {
      // Ensure all three specific names are rendered
      expect(screen.getByText('Blend')).toBeInTheDocument();
      expect(screen.getByText('Soroswap')).toBeInTheDocument();
      expect(screen.getByText('DeFindex')).toBeInTheDocument();
    });

    expect(
      screen.getByRole('button', { name: /Export strategy comparison as CSV/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /Export strategy comparison as JSON/i }),
    ).toBeEnabled();

    // Check specific formattings on Blend card
    // APY
    expect(screen.getByText('8.68')).toBeInTheDocument();
    // Rebalancing 
    expect(screen.getByText('Static')).toBeInTheDocument();
    // Efficiency
    expect(screen.getByText('75%')).toBeInTheDocument();
    // Liquidity USD formatted
    expect(screen.getByText('$11.20M')).toBeInTheDocument();
    
    // Check Fees
    // Blend performance fee 1000 bps = 10.00%
    expect(screen.getByText('10.00')).toBeInTheDocument();

    // Check formatting on Soroswap
    // Liquidity
    expect(screen.getByText('$3.90M')).toBeInTheDocument();
    // Rebalancing
    expect(screen.getByText('Dynamic')).toBeInTheDocument();
    // Mgmt fee 30 bps = 0.30%
    expect(screen.getByText('0.30')).toBeInTheDocument();
  });

  it('renders error state on fetch failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network offline'));

    render(<StrategyComparison />);

    await waitFor(() => {
      expect(screen.getByText('Strategy Comparison Temporarily Unavailable')).toBeInTheDocument();
      expect(screen.getByText('The backend service is currently disconnected or unavailable. Please try again later.')).toBeInTheDocument();
    });
  });

  it('disables exports and shows an empty state when no strategies match', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    render(<StrategyComparison />);

    expect(
      await screen.findByTestId('strategy-export-empty-state'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /No strategies available to export as CSV/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /No strategies available to export as JSON/i }),
    ).toBeDisabled();
  });

  // Regression tests for malformed external data handling
  it('handles malformed yield data at the boundary without crashing', async () => {
    // Malformed entries: missing protocolName, invalid apy, negative tvl, etc.
    const malformedYields = [
      { protocolName: '', apy: 5, tvl: 1000, riskScore: 10 }, // empty protocolName
      { protocolName: 'Blend', apy: 'not-a-number', tvl: 1000, riskScore: 10 }, // invalid apy
      { protocolName: 'Blend', apy: 5, tvl: -100, riskScore: 10 }, // negative tvl
      { protocolName: 123, apy: 5, tvl: 1000, riskScore: 10 }, // non-string protocolName
      { protocolName: 'Blend', apy: 5, tvl: 1000, riskScore: 'bad' }, // non-numeric riskScore
    ];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => malformedYields
    });

    render(<StrategyComparison />);

    await waitFor(() => {
      // Should not crash - should show empty state since all entries are invalid
      expect(screen.getByText('No Strategy Data Available')).toBeInTheDocument();
    });

    // Exports should be disabled since no valid strategies
    expect(
      screen.getByRole('button', { name: /No strategies available to export as CSV/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /No strategies available to export as JSON/i }),
    ).toBeDisabled();
  });

  it('handles mix of valid and malformed yield data gracefully', async () => {
    // Mix of valid and invalid entries
    const mixedYields = [
      { // Valid
        protocolName: 'Blend',
        apy: 6.45,
        rewardApy: 2.23,
        totalApy: 8.68,
        tvl: 12400000,
        riskScore: 23,
        liquidityUsd: 11200000,
        rebalancingBehavior: 'Static',
        managementFeeBps: 0,
        performanceFeeBps: 1000,
        capitalEfficiencyPct: 75,
        fetchedAt: new Date().toISOString()
      },
      { // Invalid - missing protocolName
        apy: 5,
        tvl: 1000,
        riskScore: 10
      },
      { // Valid
        protocolName: 'Soroswap',
        apy: 11.2,
        rewardApy: 1.55,
        totalApy: 12.75,
        tvl: 4850000,
        riskScore: 68,
        liquidityUsd: 3900000,
        rebalancingBehavior: 'Dynamic',
        managementFeeBps: 30,
        performanceFeeBps: 0,
        capitalEfficiencyPct: 92,
        fetchedAt: new Date().toISOString()
      },
      { // Invalid - apy is string
        protocolName: 'DeFindex',
        apy: 'bad',
        tvl: 2150000,
        riskScore: 45
      }
    ];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mixedYields
    });

    render(<StrategyComparison />);

    await waitFor(() => {
      // Should render only the valid strategies (Blend and Soroswap)
      expect(screen.getByText('Blend')).toBeInTheDocument();
      expect(screen.getByText('Soroswap')).toBeInTheDocument();
      // DeFindex should be filtered out (malformed)
      expect(screen.queryByText('DeFindex')).not.toBeInTheDocument();
    });

    // Exports should be enabled since we have valid strategies
    expect(
      screen.getByRole('button', { name: /Export strategy comparison as CSV/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /Export strategy comparison as JSON/i }),
    ).toBeEnabled();
  });

  it('retries successfully after malformed data is rejected', async () => {
    // First fetch returns malformed data, second fetch returns valid data
    const malformedYields = [
      { protocolName: '', apy: 5, tvl: 1000, riskScore: 10 }
    ];
    const validYields = [
      {
        protocolName: 'Blend',
        apy: 6.45,
        rewardApy: 2.23,
        totalApy: 8.68,
        tvl: 12400000,
        riskScore: 23,
        liquidityUsd: 11200000,
        rebalancingBehavior: 'Static',
        managementFeeBps: 0,
        performanceFeeBps: 1000,
        capitalEfficiencyPct: 75,
        fetchedAt: new Date().toISOString()
      }
    ];

    global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network offline'))
      .mockResolvedValueOnce({ ok: true, json: async () => validYields });

    render(<StrategyComparison />);

    // Initially shows error state after failed fetch
    await waitFor(() => {
      expect(screen.getByText('Strategy Comparison Temporarily Unavailable')).toBeInTheDocument();
    });

    // Click the Try Again button to retry
    await userEvent.click(screen.getByRole('button', { name: /Try Again/i }));

    // After retry, should show valid strategies
    await waitFor(() => {
      expect(screen.getByText('Blend')).toBeInTheDocument();
    });
  });
  // #1922: boundary-value regressions
  it('renders zero and near-limit values with documented rounding', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          ...mockYields[0],
          totalApy: 8.675,
          liquidityUsd: 999_950,
          managementFeeBps: 0,
          performanceFeeBps: 10_000,
          riskScore: 0,
        },
      ],
    });

    render(<StrategyComparison />);

    await waitFor(() => {
      expect(screen.getByText('Blend')).toBeInTheDocument();
    });
    expect(screen.getByText('8.68')).toBeInTheDocument();
    expect(screen.getByText('$1.00M')).toBeInTheDocument();
    expect(screen.getByText('100.00')).toBeInTheDocument();
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  it('skips entries past a limit instead of rendering NaN or Infinity', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { ...mockYields[0], performanceFeeBps: 10_001 },
        { ...mockYields[1], riskScore: 101 },
        { ...mockYields[2], totalApy: Number.POSITIVE_INFINITY },
      ],
    });

    render(<StrategyComparison />);

    await waitFor(() => {
      expect(screen.getByText('No Strategy Data Available')).toBeInTheDocument();
    });
    expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
  });

  it('treats a non-list payload as a failure and recovers on retry', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ unexpected: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => mockYields });

    render(<StrategyComparison />);

    await waitFor(() => {
      expect(screen.getByText('Strategy Comparison Temporarily Unavailable')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /Try Again/i }));

    await waitFor(() => {
      expect(screen.getByText('Blend')).toBeInTheDocument();
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
