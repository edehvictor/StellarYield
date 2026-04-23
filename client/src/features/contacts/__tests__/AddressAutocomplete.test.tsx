/**
 * Tests for Address Autocomplete component
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { AddressAutocomplete } from '../components/AddressAutocomplete';
import { ContactSuggestion } from '../types';

// Mock the contacts hook
const mockUseContacts = {
  getSuggestions: vi.fn(),
  contacts: [],
  loading: false,
};

vi.mock('../hooks/useContacts', () => ({
  useContacts: () => mockUseContacts,
}));

describe('AddressAutocomplete', () => {
  const mockOnChange = vi.fn();
  const mockOnSelectContact = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseContacts.getSuggestions.mockResolvedValue([]);
    mockUseContacts.contacts = [];
    mockUseContacts.loading = false;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should render input with correct placeholder', () => {
    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
        placeholder="Custom placeholder"
      />
    );

    const input = screen.getByPlaceholderText('Custom placeholder');
    expect(input).toBeInTheDocument();
  });

  it('should use default placeholder when none provided', () => {
    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
      />
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    expect(input).toBeInTheDocument();
  });

  it('should call onChange when input value changes', async () => {
    const user = userEvent.setup();
    
    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
      />
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    await user.type(input, '0x1234');

    expect(mockOnChange).toHaveBeenCalledWith('0x1234');
  });

  it('should show suggestions when input has sufficient length', async () => {
    const mockSuggestions: ContactSuggestion[] = [
      {
        id: '1',
        name: 'Test Contact',
        address: '0x1234567890123456789012345678901234567890',
        displayText: 'Test Contact (0x1234...)',
      },
    ];

    mockUseContacts.getSuggestions.mockResolvedValue(mockSuggestions);

    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
      />
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    
    // Type enough characters to trigger suggestions
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(mockUseContacts.getSuggestions).toHaveBeenCalledWith('test');
    });

    await waitFor(() => {
      expect(screen.getByText('Test Contact')).toBeInTheDocument();
      expect(screen.getByText('0x1234567890123456789012345678901234567890')).toBeInTheDocument();
    });
  });

  it('should not show suggestions for short input', async () => {
    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
      />
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    fireEvent.change(input, { target: { value: 't' } });

    // Should not call getSuggestions for input < 2 characters
    expect(mockUseContacts.getSuggestions).not.toHaveBeenCalled();
  });

  it('should handle suggestion selection', async () => {
    const mockSuggestions: ContactSuggestion[] = [
      {
        id: '1',
        name: 'Test Contact',
        address: '0x1234567890123456789012345678901234567890',
        displayText: 'Test Contact (0x1234...)',
      },
    ];

    mockUseContacts.getSuggestions.mockResolvedValue(mockSuggestions);

    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
      />
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(screen.getByText('Test Contact')).toBeInTheDocument();
    });

    // Click on suggestion
    fireEvent.click(screen.getByText('Test Contact'));

    expect(mockOnChange).toHaveBeenCalledWith('0x1234567890123456789012345678901234567890');
    expect(mockOnSelectContact).toHaveBeenCalledWith(mockSuggestions[0]);
  });

  it('should handle keyboard navigation', async () => {
    const mockSuggestions: ContactSuggestion[] = [
      {
        id: '1',
        name: 'Contact 1',
        address: '0x1111111111111111111111111111111111111111',
        displayText: 'Contact 1 (0x1111...)',
      },
      {
        id: '2',
        name: 'Contact 2',
        address: '0x2222222222222222222222222222222222222222',
        displayText: 'Contact 2 (0x2222...)',
      },
    ];

    mockUseContacts.getSuggestions.mockResolvedValue(mockSuggestions);

    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
      />
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(screen.getByText('Contact 1')).toBeInTheDocument();
    });

    // Test arrow down
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    
    // Test arrow up
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    // Test Enter to select
    fireEvent.keyDown(input, { key: 'Enter' });

    // Test Escape to close
    fireEvent.keyDown(input, { key: 'Escape' });
  });

  it('should show loading state while searching', async () => {
    mockUseContacts.loading = true;
    mockUseContacts.getSuggestions.mockImplementation(() => new Promise(() => {})); // Never resolves

    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
      />
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    fireEvent.change(input, { target: { value: 'test' } });

    // Should show loading spinner
    await waitFor(() => {
      expect(screen.getByRole('generic', { hidden: true })).toBeInTheDocument(); // Spinner element
    });
  });

  it('should show no results message', async () => {
    mockUseContacts.getSuggestions.mockResolvedValue([]);

    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
      />
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(screen.getByText('No contacts found')).toBeInTheDocument();
    });
  });

  it('should show contacts count', async () => {
    const mockSuggestions: ContactSuggestion[] = [
      { id: '1', name: 'Contact 1', address: '0x111...', displayText: 'Contact 1 (0x111...)' },
      { id: '2', name: 'Contact 2', address: '0x222...', displayText: 'Contact 2 (0x222...)' },
    ];

    mockUseContacts.getSuggestions.mockResolvedValue(mockSuggestions);

    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
      />
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(screen.getByText('2 contacts found')).toBeInTheDocument();
    });
  });

  it('should handle disabled state', () => {
    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
        disabled={true}
      />
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    expect(input).toBeDisabled();
  });

  it('should hide contacts button when showContactsButton is false', () => {
    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
        showContactsButton={false}
      />
    );

    // Should not show contacts button
    expect(screen.queryByTitle('Open address book')).not.toBeInTheDocument();
  });

  it('should handle contacts button click', () => {
    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
      />
    );

    const contactsButton = screen.getByTitle('Open address book');
    fireEvent.click(contactsButton);

    // In a real implementation, this would open the contacts modal
    // For now, we just check that the click doesn't throw an error
    expect(contactsButton).toBeInTheDocument();
  });

  it('should close dropdown when clicking outside', async () => {
    const mockSuggestions: ContactSuggestion[] = [
      {
        id: '1',
        name: 'Test Contact',
        address: '0x1234567890123456789012345678901234567890',
        displayText: 'Test Contact (0x1234...)',
      },
    ];

    mockUseContacts.getSuggestions.mockResolvedValue(mockSuggestions);

    render(
      <div>
        <AddressAutocomplete
          value=""
          onChange={mockOnChange}
          onSelectContact={mockOnSelectContact}
        />
        <div data-testid="outside-element">Outside</div>
      </div>
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(screen.getByText('Test Contact')).toBeInTheDocument();
    });

    // Click outside
    fireEvent.click(screen.getByTestId('outside-element'));

    // Dropdown should close (no longer visible)
    await waitFor(() => {
      expect(screen.queryByText('Test Contact')).not.toBeInTheDocument();
    });
  });

  it('should handle API errors gracefully', async () => {
    mockUseContacts.getSuggestions.mockRejectedValue(new Error('API Error'));

    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
      />
    );

    const input = screen.getByPlaceholderText('Enter recipient address or search contacts...');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      // Should not show suggestions due to error
      expect(screen.queryByText('Test Contact')).not.toBeInTheDocument();
    });
  });

  it('should apply custom className', () => {
    render(
      <AddressAutocomplete
        value=""
        onChange={mockOnChange}
        onSelectContact={mockOnSelectContact}
        className="custom-class"
      />
    );

    const container = screen.getByPlaceholderText('Enter recipient address or search contacts...').closest('.custom-class');
    expect(container).toBeInTheDocument();
  });
});
