import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import StrategyComparison from './StrategyComparison';

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
      expect(screen.getByText('Failed to Load Strategy Data')).toBeInTheDocument();
      expect(screen.getByText('Network offline')).toBeInTheDocument();
    });
  });
});
