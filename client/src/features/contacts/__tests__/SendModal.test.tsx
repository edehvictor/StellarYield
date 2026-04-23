/**
 * Tests for Send Modal component (example integration)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SendModal } from '../components/SendModal';
import { ContactSuggestion } from '../types';

describe('SendModal', () => {
  const mockOnClose = vi.fn();
  const mockWalletAddress = '0x1234567890123456789012345678901234567890';
  const mockBalance = '1000.50';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
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

    expect(screen.getByText('Send')).toBeInTheDocument();
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
    fireEvent.change(addressInput, { target: { value: '0x9876543210987654321098765432109876543210' } });

    expect(addressInput).toHaveValue('0x9876543210987654321098765432109876543210');
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

    const amountInput = screen.getByPlaceholderText('0.00');
    expect(amountInput).toHaveValue(mockBalance);
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

    fireEvent.change(addressInput, { target: { value: '0x9876543210987654321098765432109876543210' } });
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

    const fullAddress = '0x9876543210987654321098765432109876543210';
    fireEvent.change(addressInput, { target: { value: fullAddress } });
    fireEvent.change(amountInput, { target: { value: '100' } });

    expect(screen.getByText('0x9876...3210')).toBeInTheDocument();
  });

  it('should handle contact selection', () => {
    const mockContact: ContactSuggestion = {
      id: '1',
      name: 'Alice',
      address: '0x9876543210987654321098765432109876543210',
      displayText: 'Alice (0x9876...)',
    };

    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    
    // Simulate contact selection (would normally come from AddressAutocomplete)
    fireEvent.change(addressInput, { target: { value: mockContact.address } });

    expect(screen.getByText('Sending to Alice')).toBeInTheDocument();
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

    const sendButton = screen.getByText('Send');
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(screen.getByText('Please fill in all fields')).toBeInTheDocument();
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
    const sendButton = screen.getByText('Send');

    fireEvent.change(addressInput, { target: { value: '0x9876543210987654321098765432109876543210' } });
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
    const sendButton = screen.getByText('Send');

    fireEvent.change(addressInput, { target: { value: '0x9876543210987654321098765432109876543210' } });
    fireEvent.change(amountInput, { target: { value: '2000' } }); // More than balance
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(screen.getByText('Insufficient balance')).toBeInTheDocument();
    });
  });

  it('should handle successful send transaction', async () => {
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
    const sendButton = screen.getByText('Send');

    fireEvent.change(addressInput, { target: { value: '0x9876543210987654321098765432109876543210' } });
    fireEvent.change(amountInput, { target: { value: '100' } });
    fireEvent.click(sendButton);

    // Should show loading state
    expect(screen.getByText('Sending...')).toBeInTheDocument();
    expect(sendButton).toBeDisabled();

    // Wait for transaction to complete
    await waitFor(() => {
      expect(mockOnClose).toHaveBeenCalled();
    }, { timeout: 3000 });
  });

  it('should handle send transaction error', async () => {
    // Mock console.error to avoid test output noise
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
    const sendButton = screen.getByText('Send');

    fireEvent.change(addressInput, { target: { value: '0x9876543210987654321098765432109876543210' } });
    fireEvent.change(amountInput, { target: { value: '100' } });

    // Mock a failed transaction by making the Promise reject
    const originalPromise = Promise;
    global.Promise = vi.fn().mockImplementation((fn) => {
      if (fn && fn.toString().includes('setTimeout')) {
        return originalPromise.reject(new Error('Transaction failed'));
      }
      return originalPromise.resolve().then(fn);
    }) as any;

    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(screen.getByText('Transaction failed')).toBeInTheDocument();
    });

    // Restore original Promise
    global.Promise = originalPromise;
    consoleSpy.mockRestore();
  });

  it('should open contacts modal when contacts button is clicked', () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const contactsButton = screen.getByTitle('Open address book');
    fireEvent.click(contactsButton);

    // ContactsModal should be rendered (we can see this by checking for the modal content)
    // In a real test, we might need to mock the ContactsModal component
  });

  it('should disable send button when form is incomplete', () => {
    render(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    const sendButton = screen.getByText('Send');
    
    // Initially disabled (no address or amount)
    expect(sendButton).toBeDisabled();

    // Fill address only
    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    fireEvent.change(addressInput, { target: { value: '0x9876543210987654321098765432109876543210' } });
    expect(sendButton).toBeDisabled();

    // Fill amount
    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '100' } });
    expect(sendButton).not.toBeDisabled();
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

    // Fill form
    const addressInput = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    const amountInput = screen.getByPlaceholderText('0.00');
    
    fireEvent.change(addressInput, { target: { value: '0x9876543210987654321098765432109876543210' } });
    fireEvent.change(amountInput, { target: { value: '100' } });

    // Close modal
    rerender(
      <SendModal
        isOpen={false}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    // Reopen modal
    rerender(
      <SendModal
        isOpen={true}
        onClose={mockOnClose}
        walletAddress={mockWalletAddress}
        balance={mockBalance}
      />
    );

    // Form should be reset
    expect(addressInput).toHaveValue('');
    expect(amountInput).toHaveValue(null);
  });
});
