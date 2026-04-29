/**
 * React hook for managing encrypted contacts
 * Provides state management and CRUD operations for contacts
 */

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '../../context/useWallet';
import type { Contact, ContactData, ContactSuggestion } from '../types';
import { 
  deriveEncryptionKey, 
  isValidWalletAddress,
  isValidContactName,
} from '../utils/encryption';
import {
  getContacts,
  createContact,
  updateContact,
  deleteContact,
  searchContacts,
  ContactsApiError
} from '../utils/api';

/**
 * Hook state interface
 */
interface UseContactsState {
  contacts: Contact[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  filteredContacts: Contact[];
}

/**
 * Hook return type
 */
interface UseContactsReturn extends UseContactsState {
  // Actions
  refreshContacts: () => Promise<void>;
  addContact: (data: ContactData) => Promise<Contact>;
  editContact: (id: string, data: Partial<ContactData>) => Promise<Contact>;
  removeContact: (id: string) => Promise<void>;
  search: (query: string) => Promise<Contact[]>;
  setSearchQuery: (query: string) => void;
  clearError: () => void;
  
  // Utilities
  getSuggestions: (query: string) => Promise<ContactSuggestion[]>;
  validateContactData: (data: ContactData) => { isValid: boolean; errors: string[] };
  isDuplicate: (name: string, address: string, excludeId?: string) => boolean;
}

/**
 * Main contacts hook
 */
export function useContacts(): UseContactsReturn {
  const { walletAddress, isConnected } = useWallet();
  
  const [state, setState] = useState<UseContactsState>({
    contacts: [],
    loading: false,
    error: null,
    searchQuery: '',
    filteredContacts: [],
  });

  // Memoized encryption key
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);

  // Derive encryption key when wallet is connected
  useEffect(() => {
    if (walletAddress && isConnected) {
      deriveEncryptionKey(walletAddress)
        .then(setEncryptionKey)
        .catch((error) => {
          console.error('Failed to derive encryption key:', error);
          setState(prev => ({
            ...prev,
            error: 'Failed to initialize encryption for contacts',
          }));
        });
    } else {
      setEncryptionKey(null);
      setState(prev => ({
        ...prev,
        contacts: [],
        filteredContacts: [],
      }));
    }
  }, [walletAddress, isConnected]);

  // Filter contacts based on search query
  useEffect(() => {
    if (!state.searchQuery.trim()) {
      setState(prev => ({
        ...prev,
        filteredContacts: prev.contacts,
      }));
      return;
    }

    const query = state.searchQuery.toLowerCase();
    const filtered = state.contacts.filter(_contact => {
      // Note: We can't filter by decrypted data here without the key
      // This would need to be done on the decrypted data after loading
      return true; // Placeholder - actual filtering would happen after decryption
    });

    setState(prev => ({
      ...prev,
      filteredContacts: filtered,
    }));
  }, [state.contacts, state.searchQuery]);

  /**
   * Refresh contacts from server
   */
  const refreshContacts = useCallback(async () => {
    if (!encryptionKey || !isConnected) return;

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const contacts = await getContacts(encryptionKey);
      setState(prev => ({
        ...prev,
        contacts,
        filteredContacts: contacts,
        loading: false,
      }));
    } catch (error) {
      const message = error instanceof ContactsApiError ? error.message : 'Failed to load contacts';
      setState(prev => ({
        ...prev,
        loading: false,
        error: message,
      }));
    }
  }, [encryptionKey, isConnected]);

  /**
   * Load contacts on initial mount and when encryption key is ready
   */
  useEffect(() => {
    if (encryptionKey && isConnected) {
      refreshContacts();
    }
  }, [encryptionKey, isConnected, refreshContacts]);

  /**
   * Add a new contact
   */
  const addContact = useCallback(async (data: ContactData): Promise<Contact> => {
    if (!encryptionKey) {
      throw new Error('Encryption not available');
    }

    const validation = validateContactData(data);
    if (!validation.isValid) {
      throw new Error(validation.errors.join(', '));
    }

    if (isDuplicate(data.name, data.address)) {
      throw new Error('A contact with this name or address already exists');
    }

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const contact = await createContact(data, encryptionKey);
      setState(prev => ({
        ...prev,
        contacts: [...prev.contacts, contact],
        filteredContacts: [...prev.filteredContacts, contact],
        loading: false,
      }));
      return contact;
    } catch (error) {
      const message = error instanceof ContactsApiError ? error.message : 'Failed to create contact';
      setState(prev => ({
        ...prev,
        loading: false,
        error: message,
      }));
      throw error;
    }
  }, [encryptionKey, state.contacts, state.filteredContacts]);

  /**
   * Edit an existing contact
   */
  const editContact = useCallback(async (id: string, updates: Partial<ContactData>): Promise<Contact> => {
    if (!encryptionKey) {
      throw new Error('Encryption not available');
    }

    // Validate updates
    if (updates.name !== undefined && !isValidContactName(updates.name)) {
      throw new Error('Invalid contact name');
    }
    if (updates.address !== undefined && !isValidWalletAddress(updates.address)) {
      throw new Error('Invalid wallet address');
    }

    // Check for duplicates (excluding current contact)
    const existingContact = state.contacts.find(c => c.id === id);
    if (existingContact) {
      const newName = updates.name || existingContact.encryptedName; // Would need decryption here
      const newAddress = updates.address || existingContact.encryptedAddress; // Would need decryption here
      
      if (isDuplicate(newName, newAddress, id)) {
        throw new Error('A contact with this name or address already exists');
      }
    }

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const updatedContact = await updateContact(id, updates, encryptionKey);
      setState(prev => ({
        ...prev,
        contacts: prev.contacts.map(c => c.id === id ? updatedContact : c),
        filteredContacts: prev.filteredContacts.map(c => c.id === id ? updatedContact : c),
        loading: false,
      }));
      return updatedContact;
    } catch (error) {
      const message = error instanceof ContactsApiError ? error.message : 'Failed to update contact';
      setState(prev => ({
        ...prev,
        loading: false,
        error: message,
      }));
      throw error;
    }
  }, [encryptionKey, state.contacts, state.filteredContacts]);

  /**
   * Remove a contact
   */
  const removeContact = useCallback(async (id: string): Promise<void> => {
    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      await deleteContact(id);
      setState(prev => ({
        ...prev,
        contacts: prev.contacts.filter(c => c.id !== id),
        filteredContacts: prev.filteredContacts.filter(c => c.id !== id),
        loading: false,
      }));
    } catch (error) {
      const message = error instanceof ContactsApiError ? error.message : 'Failed to delete contact';
      setState(prev => ({
        ...prev,
        loading: false,
        error: message,
      }));
      throw error;
    }
  }, []);

  /**
   * Search contacts
   */
  const search = useCallback(async (query: string): Promise<Contact[]> => {
    if (!encryptionKey) return [];

    try {
      return await searchContacts(query, encryptionKey);
    } catch (error) {
      console.error('Search failed:', error);
      return [];
    }
  }, [encryptionKey]);

  /**
   * Set search query
   */
  const setSearchQuery = useCallback((query: string) => {
    setState(prev => ({ ...prev, searchQuery: query }));
  }, []);

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }));
  }, []);

  /**
   * Get suggestions for auto-complete
   */
  const getSuggestions = useCallback(async (query: string): Promise<ContactSuggestion[]> => {
    if (!encryptionKey || query.length < 2) return [];

    try {
      const results = await searchContacts(query, encryptionKey);
      
      return results.map(contact => {
        // Note: This would need actual decryption of name/address
        // For now, returning placeholder data
        return {
          id: contact.id,
          name: 'Contact Name', // Would decrypt here
          address: '0x...', // Would decrypt here
          displayText: 'Contact Name (0x...)', // Would format with decrypted data
        };
      });
    } catch (error) {
      console.error('Failed to get suggestions:', error);
      return [];
    }
  }, [encryptionKey]);

  /**
   * Validate contact data
   */
  const validateContactData = useCallback((data: ContactData): { isValid: boolean; errors: string[] } => {
    const errors: string[] = [];

    if (!isValidContactName(data.name)) {
      errors.push('Name must be between 1 and 100 characters');
    }

    if (!isValidWalletAddress(data.address)) {
      errors.push('Invalid wallet address format');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }, []);

  /**
   * Check for duplicate contacts
   */
  const isDuplicate = useCallback((name: string, address: string, excludeId?: string): boolean => {
    // Note: This would need actual decryption of contact data
    // For now, returning false as placeholder
    return false;
  }, [state.contacts]);

  return {
    ...state,
    refreshContacts,
    addContact,
    editContact,
    removeContact,
    search,
    setSearchQuery,
    clearError,
    getSuggestions,
    validateContactData,
    isDuplicate,
  };
}
