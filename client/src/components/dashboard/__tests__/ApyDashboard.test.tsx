import { render, screen } from '@testing-library/react';
import ApyDashboard from '../ApyDashboard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('ApyDashboard Data Freshness & Risk Badges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders stale data warning when fetchedAt is over 5 minutes old', async () => {
    const staleTime = new Date(Date.now() - 6 * 60000).toISOString();
    
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{
        protocol: 'TestProtocol',
        asset: 'USDC',
        apy: 5.0,
        tvl: 1000,
        risk: 'Low',
        fetchedAt: staleTime
      }]
    });

    render(<ApyDashboard />);

    // Wait for the mock to resolve and load data
    const staleBadge = await screen.findAllByText(/Stale Data/i);
    expect(staleBadge.length).toBeGreaterThan(0);
  });

  it('renders fresh data indicator when fetchedAt is recent', async () => {
    const freshTime = new Date().toISOString();
    
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{
        protocol: 'FreshProtocol',
        asset: 'XLM',
        apy: 12.0,
        tvl: 5000,
        risk: 'Medium',
        fetchedAt: freshTime
      }]
    });

    render(<ApyDashboard />);

    const freshText = await screen.findAllByText(/Updated just now/i);
    expect(freshText.length).toBeGreaterThan(0);
  });

  it('renders risk explanations', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{
        protocol: 'FreshProtocol',
        asset: 'XLM',
        apy: 12.0,
        tvl: 5000,
        risk: 'Medium',
        fetchedAt: new Date().toISOString()
      }]
    });

    render(<ApyDashboard />);

    // Search for the tooltip text
    const explanationText = await screen.findAllByText(/Moderate volatility or newer protocol/i);
    expect(explanationText.length).toBeGreaterThan(0);
  });
});
