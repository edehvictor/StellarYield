/**
 * Contact interface for encrypted address book
 */
export interface Contact {
  id: string;
  encryptedName: string; // Base64 encoded encrypted name
  encryptedAddress: string; // Base64 encoded encrypted address
  createdAt: string;
  updatedAt: string;
}

/**
 * Contact data before encryption (client-side only)
 */
export interface ContactData {
  name: string;
  address: string;
}

/**
 * Encrypted contact response from API
 */
export interface EncryptedContactResponse {
  id: string;
  encrypted_name: string;
  encrypted_address: string;
  created_at: string;
  updated_at: string;
}

/**
 * Encryption key information
 */
export interface EncryptionKey {
  algorithm: string;
  key: CryptoKey;
  iv: Uint8Array;
}

/**
 * API response types
 */
export interface ContactsResponse {
  contacts: Contact[];
  total: number;
}

export interface CreateContactRequest {
  encryptedName: string;
  encryptedAddress: string;
}

export interface UpdateContactRequest {
  encryptedName?: string;
  encryptedAddress?: string;
}

/**
 * Auto-complete suggestion
 */
export interface ContactSuggestion {
  id: string;
  name: string;
  address: string;
  displayText: string;
}
