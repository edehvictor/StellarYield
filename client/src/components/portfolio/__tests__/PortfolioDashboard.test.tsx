import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PortfolioDashboard from '../PortfolioDashboard';

describe('PortfolioDashboard', () => {
  it('renders empty state when user has no positions', async () => {
    const { container } = render(<PortfolioDashboard walletAddress="GTEST..." />);

    // Wait for loading to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check for empty state message
    expect(screen.getByText('No Active Positions')).toBeInTheDocument();
    expect(screen.getByText(/start investing to build your portfolio/i)).toBeInTheDocument();
  });

  it('displays loading spinner initially', () => {
    const { container } = render(<PortfolioDashboard walletAddress="GTEST..." />);

    // SVG spinner should be present during loading
    const spinner = container.querySelector('svg');
    expect(spinner).toBeInTheDocument();
  });
});
