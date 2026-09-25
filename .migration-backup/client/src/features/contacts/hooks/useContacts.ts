/**
 * React hook for managing encrypted contacts
 * Provides state management and CRUD operations for contacts
 */

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '../../../context/useWallet';
import type { Contact, ContactData, ContactSuggestion } from '../types';
import { 
  deriveEncryptionKey, 
  isValidWalletAddress,
  isValidContactName,
  decryptName,
  decryptAddress,
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

function validateContactData(data: ContactData): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isValidContactName(data.name)) errors.push('Name must be between 1 and 100 characters');
  if (!isValidWalletAddress(data.address)) errors.push('Invalid wallet address format');
  return { isValid: errors.length === 0, errors };
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
      const encryptedContacts = await getContacts(encryptionKey);
      const decrypted = await Promise.all(
        encryptedContacts.map(async (c) => {
          try {
            const name = await decryptName(c.encryptedName, encryptionKey);
            const address = await decryptAddress(c.encryptedAddress, encryptionKey);
            return { ...c, name, address };
          } catch (err) {
            console.error(`Failed to decrypt contact ${c.id}:`, err);
            return { ...c, name: 'Decryption Error', address: '' };
          }
        })
      );
      setState(prev => ({
        ...prev,
        contacts: decrypted,
        filteredContacts: decrypted,
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

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const contact = await createContact(data, encryptionKey);
      const decryptedContact = { ...contact, name: data.name, address: data.address };
      setState(prev => ({
        ...prev,
        contacts: [...prev.contacts, decryptedContact],
        filteredContacts: [...prev.filteredContacts, decryptedContact],
        loading: false,
      }));
      return decryptedContact;
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
      const newName = updates.name !== undefined ? updates.name : (existingContact.name ?? '');
      const newAddress = updates.address !== undefined ? updates.address : (existingContact.address ?? '');
      
      if (isDuplicate(newName, newAddress, id)) {
        throw new Error('A contact with this name or address already exists');
      }
    }

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const updatedContact = await updateContact(id, updates, encryptionKey);
      const existing = state.contacts.find(c => c.id === id);
      const decryptedUpdated = {
        ...updatedContact,
        name: updates.name !== undefined ? updates.name : existing?.name,
        address: updates.address !== undefined ? updates.address : existing?.address,
      };
      setState(prev => ({
        ...prev,
        contacts: prev.contacts.map(c => c.id === id ? decryptedUpdated : c),
        filteredContacts: prev.filteredContacts.map(c => c.id === id ? decryptedUpdated : c),
        loading: false,
      }));
      return decryptedUpdated;
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
      
      const suggestions = await Promise.all(
        results.map(async (contact) => {
          try {
            const name = await decryptName(contact.encryptedName, encryptionKey);
            const address = await decryptAddress(contact.encryptedAddress, encryptionKey);
            return {
              id: contact.id,
              name,
              address,
              displayText: `${name} (${address})`,
            };
          } catch (err) {
            console.error(`Failed to decrypt suggestion contact ${contact.id}:`, err);
            return {
              id: contact.id,
              name: 'Decryption Error',
              address: '',
              displayText: 'Decryption Error',
            };
          }
        })
      );
      return suggestions;
    } catch (error) {
      console.error('Failed to get suggestions:', error);
      return [];
    }
  }, [encryptionKey]);


  /**
   * Check for duplicate contacts
   */
  const isDuplicate = useCallback((name: string, address: string, excludeId?: string): boolean => {
    return state.contacts.some(c => {
      if (excludeId && c.id === excludeId) return false;
      return (
        c.name?.toLowerCase().trim() === name.toLowerCase().trim() ||
        c.address?.toLowerCase().trim() === address.toLowerCase().trim()
      );
    });
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
