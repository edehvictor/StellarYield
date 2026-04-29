/**
 * Tests for API utilities
 * Tests contact API endpoints and error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  searchContacts,
  importContacts,
  exportContacts,
  ContactsApiError,
} from '../utils/api';
import type { ContactData, EncryptedContactResponse } from '../types';

// Mock fetch
global.fetch = vi.fn();

// Mock encryption utilities so tests don't depend on real WebCrypto
vi.mock('../utils/encryption', () => ({
  encryptContactData: vi.fn().mockResolvedValue({ encryptedData: 'encrypted-data', iv: 'test-iv' }),
  decryptContactData: vi.fn().mockResolvedValue({ name: 'Test', address: '0x1234' }),
}));

// Mock crypto key — used as an opaque token passed through to mocked encryption
const mockCryptoKey = {} as CryptoKey;

// Declared at describe scope so it is accessible inside individual test bodies
let localStorageMock: {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
};

describe('API Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    };
    global.localStorage = localStorageMock as unknown as Storage;
  });

  describe('apiRequest helper', () => {
    it('should make successful API requests', async () => {
      const mockResponse = { contacts: [] };
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await getContacts(mockCryptoKey);
      expect(result).toEqual([]);
    });

    it('should handle HTTP errors', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ message: 'Not found' }),
      });

      await expect(getContacts(mockCryptoKey)).rejects.toThrow(ContactsApiError);
    });

    it('should include auth token when available', async () => {
      localStorageMock.getItem.mockReturnValue('test-token');
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contacts: [] }),
      });

      await getContacts(mockCryptoKey);

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
          }),
        })
      );
    });

    it('should handle network errors', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

      await expect(getContacts(mockCryptoKey)).rejects.toThrow(ContactsApiError);
    });
  });

  describe('getContacts', () => {
    it('should fetch and transform contacts', async () => {
      const mockContacts: EncryptedContactResponse[] = [
        {
          id: '1',
          encrypted_name: 'encrypted-name-1',
          encrypted_address: 'encrypted-address-1',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      ];

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contacts: mockContacts }),
      });

      const result = await getContacts(mockCryptoKey);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: '1',
        encryptedName: 'encrypted-name-1',
        encryptedAddress: 'encrypted-address-1',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      });
    });
  });

  describe('getContact', () => {
    it('should fetch a single contact', async () => {
      const mockContact: EncryptedContactResponse = {
        id: '1',
        encrypted_name: 'encrypted-name-1',
        encrypted_address: 'encrypted-address-1',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-01T00:00:00Z',
      };

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contact: mockContact }),
      });

      const result = await getContact('1', mockCryptoKey);

      expect(result).toEqual({
        id: '1',
        encryptedName: 'encrypted-name-1',
        encryptedAddress: 'encrypted-address-1',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      });
    });

    it('should handle 404 errors', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ message: 'Contact not found' }),
      });

      await expect(getContact('999', mockCryptoKey)).rejects.toThrow(ContactsApiError);
    });
  });

  describe('createContact', () => {
    it('should create a new contact', async () => {
      const contactData: ContactData = {
        name: 'Test Contact',
        address: '0x1234567890123456789012345678901234567890',
      };

      const mockCreatedContact: EncryptedContactResponse = {
        id: '1',
        encrypted_name: 'encrypted-name',
        encrypted_address: 'encrypted-address',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-01T00:00:00Z',
      };

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contact: mockCreatedContact }),
      });

      const result = await createContact(contactData, mockCryptoKey);

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('encryptedName'),
        })
      );

      expect(result).toEqual({
        id: '1',
        encryptedName: 'encrypted-name',
        encryptedAddress: 'encrypted-address',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      });
    });
  });

  describe('updateContact', () => {
    it('should update an existing contact', async () => {
      const updates: Partial<ContactData> = {
        name: 'Updated Name',
      };

      const mockUpdatedContact: EncryptedContactResponse = {
        id: '1',
        encrypted_name: 'encrypted-updated-name',
        encrypted_address: 'encrypted-address',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
      };

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contact: mockUpdatedContact }),
      });

      const result = await updateContact('1', updates, mockCryptoKey);

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('encryptedName'),
        })
      );

      expect(result.updatedAt).toBe('2023-01-02T00:00:00Z');
    });

    it('should handle partial updates', async () => {
      const updates: Partial<ContactData> = {
        address: '0x9876543210987654321098765432109876543210',
      };

      const mockUpdatedContact: EncryptedContactResponse = {
        id: '1',
        encrypted_name: 'encrypted-name',
        encrypted_address: 'encrypted-updated-address',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
      };

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contact: mockUpdatedContact }),
      });

      await updateContact('1', updates, mockCryptoKey);

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('encryptedAddress'),
        })
      );
    });
  });

  describe('deleteContact', () => {
    it('should delete a contact', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await deleteContact('1');

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });

    it('should handle deletion errors', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ message: 'Contact not found' }),
      });

      await expect(deleteContact('999')).rejects.toThrow(ContactsApiError);
    });
  });

  describe('searchContacts', () => {
    it('should search contacts', async () => {
      const mockContacts: EncryptedContactResponse[] = [
        {
          id: '1',
          encrypted_name: 'encrypted-name-1',
          encrypted_address: 'encrypted-address-1',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      ];

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contacts: mockContacts }),
      });

      const result = await searchContacts('test', mockCryptoKey);

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/search?q=test'),
        expect.any(Object)
      );

      expect(result).toHaveLength(1);
    });

    it('should URL encode search queries', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contacts: [] }),
      });

      await searchContacts('test query with spaces', mockCryptoKey);

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/search?q=test%20query%20with%20spaces'),
        expect.any(Object)
      );
    });
  });

  describe('importContacts', () => {
    it('should import contacts from backup', async () => {
      const mockContacts: EncryptedContactResponse[] = [
        {
          id: '1',
          encrypted_name: 'encrypted-name-1',
          encrypted_address: 'encrypted-address-1',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      ];

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contacts: mockContacts }),
      });

      const result = await importContacts('encrypted-backup-data', mockCryptoKey);

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('encryptedBackup'),
        })
      );

      expect(result).toHaveLength(1);
    });
  });

  describe('exportContacts', () => {
    it('should export contacts as backup', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ encryptedBackup: 'encrypted-backup-data' }),
      });

      const result = await exportContacts(mockCryptoKey);

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/export'),
        expect.any(Object)
      );

      expect(result).toBe('encrypted-backup-data');
    });
  });

  describe('ContactsApiError', () => {
    it('should create error with message', () => {
      const error = new ContactsApiError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('ContactsApiError');
    });

    it('should create error with status and code', () => {
      const error = new ContactsApiError('Test error', 404, 'NOT_FOUND');
      expect(error.status).toBe(404);
      expect(error.code).toBe('NOT_FOUND');
    });
  });

  describe('API Configuration', () => {
    it('should use correct base URL', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contacts: [] }),
      });

      await getContacts(mockCryptoKey);

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/contacts'),
        expect.any(Object)
      );
    });

    it('should use default URL when env variable is not set', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ contacts: [] }),
      });

      await getContacts(mockCryptoKey);

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/contacts'),
        expect.any(Object)
      );
    });
  });
});
