import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ReferralDashboard from '../ReferralDashboard';
import * as WalletContext from '../../../context/useWallet';

const mockUseWallet = vi.spyOn(WalletContext, 'useWallet');

describe('ReferralDashboard', () => {
  beforeEach(() => {
    mockUseWallet.mockReturnValue({
      isConnected: true,
      walletAddress: 'GTEST123456789...',
      walletAddressType: 'account',
      providerLabel: 'Freighter',
      sessionKeyAddress: null,
      verificationStatus: null,
      isConnecting: false,
      isFreighterInstalled: true,
      errorMessage: null,
      connectWallet: vi.fn(),
      disconnectWallet: vi.fn(),
      clearError: vi.fn(),
      signTransaction: vi.fn(),
    });

    // Mock fetch for referral data with no referrals
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          referredTvl: 0,
          unclaimedRewards: 0,
          totalReferrals: 0,
          referralLink: 'http://localhost/?ref=GTEST123456789',
        }),
      })
    ) as any;
  });

  it('renders empty state when user has no referrals', async () => {
    render(<ReferralDashboard />);

    await waitFor(() => {
      expect(screen.getByText('No Referrals Yet')).toBeInTheDocument();
    });

    expect(screen.getByText(/share your referral link to start earning/i)).toBeInTheDocument();
  });

  it('displays referral link section', async () => {
    render(<ReferralDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Your Referral Link/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Copy/)).toBeInTheDocument();
  });
});
