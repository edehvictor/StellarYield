/**
 * Tests for Send Modal component (example integration)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SendModal } from '../components/SendModal';
import * as sorobanService from "../../../services/soroban";
import * as StellarSdk from "@stellar/stellar-sdk";

// Mock useContacts so AddressAutocomplete doesn't need a WalletProvider
vi.mock('../hooks/useContacts', () => ({
  useContacts: () => ({
    contacts: [],
    loading: false,
    getSuggestions: vi.fn().mockResolvedValue([]),
    setSearchQuery: vi.fn(),
    clearError: vi.fn(),
    refreshContacts: vi.fn(),
    filteredContacts: [],
    error: null,
    searchQuery: '',
    addContact: vi.fn(),
    editContact: vi.fn(),
    removeContact: vi.fn(),
    search: vi.fn(),
    validateContactData: vi.fn().mockReturnValue({ isValid: true, errors: [] }),
    isDuplicate: vi.fn().mockReturnValue(false),
  }),
}));

// Mock ContactsModal to prevent deep render tree inside SendModal
vi.mock('../components/ContactsModal', () => ({
  ContactsModal: () => null,
}));

// Mock soroban service
vi.mock("../../../services/soroban", () => ({
  executeContractCallOn: vi.fn(),
}));

describe('SendModal', () => {
  const mockOnClose = vi.fn();
  // Use static valid Stellar keys to avoid Noble curves crypto issues in test env
  const mockWalletAddress = "GBJKSX33PDI67V4CNWSIBRNDRLAV2HPWGOJJBNL5GK7WRVYSDS3WBHL7";
  const mockRecipientAddress = "GBK2O2DY4DRH2CITGJMXN5PIRFTJ5U5SV5UDLRV73Z7LAPLKRNCRJOBN";
  const mockBalance = '1000.50';

  // Mock useWallet
  vi.mock("../../../context/useWallet", () => ({
    useWallet: () => ({
      walletAddress: "GBJKSX33PDI67V4CNWSIBRNDRLAV2HPWGOJJBNL5GK7WRVYSDS3WBHL7",
      isConnected: true,
      signTransaction: vi.fn().mockResolvedValue("mock-signed-xdr"),
    }),
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_USDC_SAC_CONTRACT_ID', 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB42P');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it('should not render when isOpen is false', () => {
    render(
      <SendModal
        isOpen={false}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    expect(screen.queryByText('Send')).not.toBeInTheDocument();
  });

  it('should render modal when isOpen is true', () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    expect(screen.getByRole('heading', { name: /send/i })).toBeInTheDocument();
    expect(screen.getByText('Available Balance')).toBeInTheDocument();
    expect(screen.getByText(`${mockBalance} USDC`)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter recipient address or search contacts...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument();
  });

  it('should call onClose when close button is clicked', () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const closeButton = screen.getByRole('button', { name: /close/i });
    fireEvent.click(closeButton);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('should handle recipient address change', () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    fireEvent.change(addressInput, { target: { value: mockRecipientAddress } });

    expect(addressInput).toHaveValue(mockRecipientAddress);
  });

  it('should handle amount change', () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '100' } });

    expect(amountInput).toHaveValue(100);
  });

  it('should handle MAX button click', () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const maxButton = screen.getByText('MAX');
    fireEvent.click(maxButton);

    const amountInput = screen.getByPlaceholderText('0.00') as HTMLInputElement;
    expect(amountInput.value).toBe(mockBalance);
  });

  it('should show transaction summary when address and amount are filled', () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    const amountInput = screen.getByPlaceholderText('0.00');

    fireEvent.change(addressInput, { target: { value: mockRecipientAddress } });
    fireEvent.change(amountInput, { target: { value: '100' } });

    expect(screen.getByText('To:')).toBeInTheDocument();
    expect(screen.getByText('Amount:')).toBeInTheDocument();
    expect(screen.getByText('100 USDC')).toBeInTheDocument();
    expect(screen.getByText('Network Fee:')).toBeInTheDocument();
    expect(screen.getByText('Total:')).toBeInTheDocument();
    expect(screen.getByText('100.001 USDC')).toBeInTheDocument();
  });

  it('should show shortened address in transaction summary', () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    const amountInput = screen.getByPlaceholderText('0.00');

    fireEvent.change(addressInput, { target: { value: mockRecipientAddress } });
    fireEvent.change(amountInput, { target: { value: '100' } });

    const expectedShortened = `${mockRecipientAddress.slice(0, 6)}...${mockRecipientAddress.slice(-4)}`;
    expect(screen.getByText(expectedShortened)).toBeInTheDocument();
  });

  it('should show error for empty fields', async () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));

    await waitFor(() => {
      expect(screen.getByText('Please fill in all fields')).toBeInTheDocument();
    });
  });

  it('should show error for invalid address format', async () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    const amountInput = screen.getByPlaceholderText('0.00');
    const sendButton = screen.getByRole('button', { name: /^Send$/i });

    fireEvent.change(addressInput, { target: { value: 'invalid-stellar-address' } });
    fireEvent.change(amountInput, { target: { value: '100' } });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(screen.getByText('Invalid recipient address format')).toBeInTheDocument();
    });
  });

  it('should show error for zero amount', async () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    const amountInput = screen.getByPlaceholderText('0.00');
    const sendButton = screen.getByRole('button', { name: /^Send$/i });

    fireEvent.change(addressInput, { target: { value: mockRecipientAddress } });
    fireEvent.change(amountInput, { target: { value: '0' } });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(screen.getByText('Amount must be greater than 0')).toBeInTheDocument();
    });
  });

  it('should show error for insufficient balance', async () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    const amountInput = screen.getByPlaceholderText('0.00');
    const sendButton = screen.getByRole('button', { name: /^Send$/i });

    fireEvent.change(addressInput, { target: { value: mockRecipientAddress } });
    fireEvent.change(amountInput, { target: { value: '2000' } }); // More than balance
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(screen.getByText('Insufficient balance')).toBeInTheDocument();
    });
  });

  it('should handle successful send transaction', async () => {
    vi.mocked(sorobanService.executeContractCallOn).mockResolvedValue({
      success: true,
      hash: "mock-tx-hash",
    });

    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    const amountInput = screen.getByPlaceholderText('0.00');
    const sendButton = screen.getByRole('button', { name: /^Send$/i });

    fireEvent.change(addressInput, { target: { value: mockRecipientAddress } });
    fireEvent.change(amountInput, { target: { value: '100' } });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(screen.getByText('Send Successful')).toBeInTheDocument();
    });
  });

  it('should handle send transaction error', async () => {
    vi.mocked(sorobanService.executeContractCallOn).mockResolvedValue({
      success: false,
      error: "Simulation failed: transaction rejected",
    });

    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    const amountInput = screen.getByPlaceholderText('0.00');
    const sendButton = screen.getByRole('button', { name: /^Send$/i });

    fireEvent.change(addressInput, { target: { value: mockRecipientAddress } });
    fireEvent.change(amountInput, { target: { value: '100' } });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(screen.getByText('Simulation failed: transaction rejected')).toBeInTheDocument();
    });
  });

  it('should disable inputs/buttons during transaction', async () => {
    vi.mocked(sorobanService.executeContractCallOn).mockImplementation(
      () => new Promise(() => {}) // never resolves to keep in building/submitting state
    );

    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    const amountInput = screen.getByPlaceholderText('0.00');
    const sendButton = screen.getByRole('button', { name: /^Send$/i });

    fireEvent.change(addressInput, { target: { value: mockRecipientAddress } });
    fireEvent.change(amountInput, { target: { value: '100' } });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(sendButton).toBeDisabled();
    });
  });

  it('should reset form when modal closes', () => {
    const { rerender } = render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Enter recipient address or search contacts...'), {
      target: { value: mockRecipientAddress },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '100' } });

    // Close then reopen
    rerender(<SendModal isOpen={false} onClose={mockOnClose} walletAddress={mockWalletAddress} balance={mockBalance} />);
    rerender(<SendModal isOpen={true} onClose={mockOnClose} walletAddress={mockWalletAddress} balance={mockBalance} />);

    expect(screen.getByPlaceholderText('Enter recipient address or search contacts...')).toHaveValue('');
    expect(screen.getByPlaceholderText('0.00')).toHaveValue(null);
  });
});
