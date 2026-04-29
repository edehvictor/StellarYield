/**
 * API service for encrypted contacts
 * Handles all communication with the backend for contact management
 */

import { 
  Contact, 
  ContactData, 
  EncryptedContactResponse, 
  CreateContactRequest, 
  UpdateContactRequest,
  ContactsResponse 
} from '../types';
import { decryptContactData, encryptContactData } from './encryption';
import { getApiBaseUrl } from '../../../lib/api';

/**
 * API configuration
 */
const API_BASE_URL = getApiBaseUrl();

/**
 * API error class
 */
export class ContactsApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message);
    this.name = 'ContactsApiError';
  }
}

/**
 * Generic API request helper
 */
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}/api/contacts${endpoint}`;
  
  const defaultHeaders = {
    'Content-Type': 'application/json',
  };

  // Add auth token if available
  const token = localStorage.getItem('authToken');
  if (token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new ContactsApiError(
        errorData.message || `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        errorData.code
      );
    }

    return await response.json();
  } catch (error) {
    if (error instanceof ContactsApiError) {
      throw error;
    }
    throw new ContactsApiError(
      `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Transform encrypted API response to internal Contact format
 */
function transformContactResponse(
  contact: EncryptedContactResponse,
  decrypt: (data: string) => Promise<ContactData>
): Contact {
  return {
    id: contact.id,
    encryptedName: contact.encrypted_name,
    encryptedAddress: contact.encrypted_address,
    createdAt: contact.created_at,
    updatedAt: contact.updated_at,
  };
}

/**
 * Get all contacts for the authenticated user
 * 
 * @param decryptKey Decryption key for contact data
 * @returns Promise<Contact[]> Array of contacts
 */
export async function getContacts(decryptKey: CryptoKey): Promise<Contact[]> {
  const response = await apiRequest<{ contacts: EncryptedContactResponse[] }>('');
  
  return response.contacts.map(contact => 
    transformContactResponse(contact, (data) => decryptContactData(data, decryptKey))
  );
}

/**
 * Get a single contact by ID
 * 
 * @param id Contact ID
 * @param decryptKey Decryption key for contact data
 * @returns Promise<Contact> Contact data
 */
export async function getContact(id: string, decryptKey: CryptoKey): Promise<Contact> {
  const response = await apiRequest<{ contact: EncryptedContactResponse }>(`/${id}`);
  
  return transformContactResponse(response.contact, (data) => decryptContactData(data, decryptKey));
}

/**
 * Create a new contact
 * 
 * @param contactData Contact data to create
 * @param encryptKey Encryption key for contact data
 * @returns Promise<Contact> Created contact
 */
export async function createContact(
  contactData: ContactData,
  encryptKey: CryptoKey
): Promise<Contact> {
  const { encryptedData: encryptedName } = await encryptContactData(
    { name: contactData.name, address: '' },
    encryptKey
  );
  const { encryptedData: encryptedAddress } = await encryptContactData(
    { name: '', address: contactData.address },
    encryptKey
  );

  const request: CreateContactRequest = {
    encryptedName,
    encryptedAddress,
  };

  const response = await apiRequest<{ contact: EncryptedContactResponse }>('', {
    method: 'POST',
    body: JSON.stringify(request),
  });

  return transformContactResponse(response.contact, (data) => decryptContactData(data, encryptKey));
}

/**
 * Update an existing contact
 * 
 * @param id Contact ID
 * @param updates Contact data to update
 * @param encryptKey Encryption key for contact data
 * @returns Promise<Contact> Updated contact
 */
export async function updateContact(
  id: string,
  updates: Partial<ContactData>,
  encryptKey: CryptoKey
): Promise<Contact> {
  const request: UpdateContactRequest = {};

  if (updates.name !== undefined) {
    const { encryptedData: encryptedName } = await encryptContactData(
      { name: updates.name, address: '' },
      encryptKey
    );
    request.encryptedName = encryptedName;
  }

  if (updates.address !== undefined) {
    const { encryptedData: encryptedAddress } = await encryptContactData(
      { name: '', address: updates.address },
      encryptKey
    );
    request.encryptedAddress = encryptedAddress;
  }

  const response = await apiRequest<{ contact: EncryptedContactResponse }>(`/${id}`, {
    method: 'PUT',
    body: JSON.stringify(request),
  });

  return transformContactResponse(response.contact, (data) => decryptContactData(data, encryptKey));
}

/**
 * Delete a contact
 * 
 * @param id Contact ID
 * @returns Promise<void>
 */
export async function deleteContact(id: string): Promise<void> {
  await apiRequest<void>(`/${id}`, {
    method: 'DELETE',
  });
}

/**
 * Search contacts by name or address
 * 
 * @param query Search query
 * @param decryptKey Decryption key for contact data
 * @returns Promise<Contact[]> Matching contacts
 */
export async function searchContacts(
  query: string,
  decryptKey: CryptoKey
): Promise<Contact[]> {
  const encodedQuery = encodeURIComponent(query);
  const response = await apiRequest<{ contacts: EncryptedContactResponse[] }>(`/search?q=${encodedQuery}`);
  
  return response.contacts.map(contact => 
    transformContactResponse(contact, (data) => decryptContactData(data, decryptKey))
  );
}

/**
 * Import contacts from encrypted backup
 * 
 * @param encryptedBackup Base64 encoded encrypted backup data
 * @param decryptKey Decryption key for backup data
 * @returns Promise<Contact[]> Imported contacts
 */
export async function importContacts(
  encryptedBackup: string,
  decryptKey: CryptoKey
): Promise<Contact[]> {
  const response = await apiRequest<{ contacts: EncryptedContactResponse[] }>('/import', {
    method: 'POST',
    body: JSON.stringify({ encryptedBackup }),
  });

  return response.contacts.map(contact => 
    transformContactResponse(contact, (data) => decryptContactData(data, decryptKey))
  );
}

/**
 * Export contacts as encrypted backup
 * 
 * @param encryptKey Encryption key for backup data
 * @returns Promise<string> Base64 encoded encrypted backup
 */
export async function exportContacts(encryptKey: CryptoKey): Promise<string> {
  const response = await apiRequest<{ encryptedBackup: string }>('/export');
  return response.encryptedBackup;
}
