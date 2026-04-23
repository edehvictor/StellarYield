/**
 * Tests for Contacts Modal component
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ContactsModal } from '../components/ContactsModal';
import { Contact, ContactData } from '../types';

// Mock the contacts hook
const mockUseContacts = {
  contacts: [],
  filteredContacts: [],
  loading: false,
  error: null,
  searchQuery: '',
  refreshContacts: vi.fn(),
  addContact: vi.fn(),
  editContact: vi.fn(),
  removeContact: vi.fn(),
  search: vi.fn(),
  setSearchQuery: vi.fn(),
  clearError: vi.fn(),
  getSuggestions: vi.fn(),
  validateContactData: vi.fn(),
  isDuplicate: vi.fn(),
};

vi.mock('../hooks/useContacts', () => ({
  useContacts: () => mockUseContacts,
}));

// Mock clipboard API
const mockClipboard = {
  writeText: vi.fn(),
};

Object.assign(navigator, {
  clipboard: mockClipboard,
});

describe('ContactsModal', () => {
  const mockOnClose = vi.fn();
  const mockOnSelectContact = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseContacts.contacts = [];
    mockUseContacts.filteredContacts = [];
    mockUseContacts.loading = false;
    mockUseContacts.error = null;
    mockUseContacts.searchQuery = '';
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should not render when isOpen is false', () => {
    render(
      <ContactsModal
        isOpen={false}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    expect(screen.queryByText('Address Book')).not.toBeInTheDocument();
  });

  it('should render modal when isOpen is true', () => {
    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    expect(screen.getByText('Address Book')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search contacts...')).toBeInTheDocument();
    expect(screen.getByText('Add Contact')).toBeInTheDocument();
  });

  it('should call onClose when close button is clicked', () => {
    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    const closeButton = screen.getByRole('button', { name: /close/i });
    fireEvent.click(closeButton);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('should call refreshContacts when modal opens', () => {
    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    expect(mockUseContacts.refreshContacts).toHaveBeenCalled();
  });

  it('should display loading state', () => {
    mockUseContacts.loading = true;

    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    expect(screen.getByText('Loading contacts...')).toBeInTheDocument();
  });

  it('should display empty state when no contacts', () => {
    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    expect(screen.getByText('No contacts yet. Add your first contact!')).toBeInTheDocument();
  });

  it('should display contacts when available', () => {
    const mockContacts: Contact[] = [
      {
        id: '1',
        encryptedName: 'encrypted-name-1',
        encryptedAddress: 'encrypted-address-1',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      },
    ];

    mockUseContacts.contacts = mockContacts;
    mockUseContacts.filteredContacts = mockContacts;

    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    // Note: Since data is encrypted, we're checking for placeholder text
    // In a real implementation, this would show decrypted data
    expect(screen.getByText('Contact Name')).toBeInTheDocument();
    expect(screen.getByText('0x1234...5678')).toBeInTheDocument();
  });

  it('should show add form when Add Contact is clicked', () => {
    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    const addButton = screen.getByText('Add Contact');
    fireEvent.click(addButton);

    expect(screen.getByText('Add New Contact')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter contact name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('0x...')).toBeInTheDocument();
  });

  it('should handle form submission for new contact', async () => {
    mockUseContacts.validateContactData.mockReturnValue({ isValid: true, errors: [] });
    mockUseContacts.isDuplicate.mockReturnValue(false);
    mockUseContacts.addContact.mockResolvedValue({} as Contact);

    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    // Open add form
    const addButton = screen.getByText('Add Contact');
    fireEvent.click(addButton);

    // Fill form
    const nameInput = screen.getByPlaceholderText('Enter contact name');
    const addressInput = screen.getByPlaceholderText('0x...');

    fireEvent.change(nameInput, { target: { value: 'Test Contact' } });
    fireEvent.change(addressInput, { target: { value: '0x1234567890123456789012345678901234567890' } });

    // Submit form
    const submitButton = screen.getByText('Add');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockUseContacts.addContact).toHaveBeenCalledWith({
        name: 'Test Contact',
        address: '0x1234567890123456789012345678901234567890',
      });
    });
  });

  it('should display validation errors', async () => {
    mockUseContacts.validateContactData.mockReturnValue({
      isValid: false,
      errors: ['Invalid name', 'Invalid address'],
    });

    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    // Open add form
    const addButton = screen.getByText('Add Contact');
    fireEvent.click(addButton);

    // Submit empty form
    const submitButton = screen.getByText('Add');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Invalid name')).toBeInTheDocument();
      expect(screen.getByText('Invalid address')).toBeInTheDocument();
    });
  });

  it('should handle search input', () => {
    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    const searchInput = screen.getByPlaceholderText('Search contacts...');
    fireEvent.change(searchInput, { target: { value: 'test query' } });

    expect(mockUseContacts.setSearchQuery).toHaveBeenCalledWith('test query');
  });

  it('should display error message when error exists', () => {
    mockUseContacts.error = 'Failed to load contacts';

    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    expect(screen.getByText('Failed to load contacts')).toBeInTheDocument();
  });

  it('should handle contact selection', () => {
    const mockContacts: Contact[] = [
      {
        id: '1',
        encryptedName: 'encrypted-name-1',
        encryptedAddress: 'encrypted-address-1',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      },
    ];

    mockUseContacts.contacts = mockContacts;
    mockUseContacts.filteredContacts = mockContacts;

    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    // Click select button
    const selectButton = screen.getByTitle('Select this contact');
    fireEvent.click(selectButton);

    expect(mockOnSelectContact).toHaveBeenCalledWith(mockContacts[0]);
  });

  it('should handle contact deletion', async () => {
    const mockContacts: Contact[] = [
      {
        id: '1',
        encryptedName: 'encrypted-name-1',
        encryptedAddress: 'encrypted-address-1',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      },
    ];

    mockUseContacts.contacts = mockContacts;
    mockUseContacts.filteredContacts = mockContacts;
    mockUseContacts.removeContact.mockResolvedValue();

    // Mock window.confirm
    window.confirm = vi.fn(() => true);

    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    // Click delete button
    const deleteButton = screen.getByTitle('Delete contact');
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalledWith('Are you sure you want to delete this contact?');
      expect(mockUseContacts.removeContact).toHaveBeenCalledWith('1');
    });
  });

  it('should handle copy address', async () => {
    const mockContacts: Contact[] = [
      {
        id: '1',
        encryptedName: 'encrypted-name-1',
        encryptedAddress: 'encrypted-address-1',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      },
    ];

    mockUseContacts.contacts = mockContacts;
    mockUseContacts.filteredContacts = mockContacts;

    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    // Click copy button
    const copyButton = screen.getByTitle('Copy address');
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(mockClipboard.writeText).toHaveBeenCalledWith('0x...');
    });
  });

  it('should handle view on explorer', () => {
    const mockContacts: Contact[] = [
      {
        id: '1',
        encryptedName: 'encrypted-name-1',
        encryptedAddress: 'encrypted-address-1',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      },
    ];

    mockUseContacts.contacts = mockContacts;
    mockUseContacts.filteredContacts = mockContacts;

    // Mock window.open
    window.open = vi.fn();

    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    // Click explorer button
    const explorerButton = screen.getByTitle('View on Etherscan');
    fireEvent.click(explorerButton);

    expect(window.open).toHaveBeenCalledWith(
      'https://etherscan.io/address/0x...',
      '_blank'
    );
  });

  it('should handle edit contact', () => {
    const mockContacts: Contact[] = [
      {
        id: '1',
        encryptedName: 'encrypted-name-1',
        encryptedAddress: 'encrypted-address-1',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      },
    ];

    mockUseContacts.contacts = mockContacts;
    mockUseContacts.filteredContacts = mockContacts;

    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    // Click edit button
    const editButton = screen.getByTitle('Edit contact');
    fireEvent.click(editButton);

    expect(screen.getByText('Edit Contact')).toBeInTheDocument();
  });

  it('should handle form cancellation', () => {
    render(
      <ContactsModal
        isOpen={true}
        onClose={mockOnClose}
        onSelectContact={mockOnSelectContact}
      />
    );

    // Open add form
    const addButton = screen.getByText('Add Contact');
    fireEvent.click(addButton);

    // Click cancel
    const cancelButton = screen.getByText('Cancel');
    fireEvent.click(cancelButton);

    // Form should be hidden
    expect(screen.queryByText('Add New Contact')).not.toBeInTheDocument();
  });
});
