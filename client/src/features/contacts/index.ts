/**
 * Encrypted Address Book Feature
 * 
 * This feature provides a secure, client-side encrypted address book for StellarYield users.
 * 
 * Key Features:
 * - Client-side encryption using Web Crypto API (AES-GCM)
 * - Secure storage of contact names and addresses
 * - Auto-complete functionality for recipient addresses
 * - Full CRUD operations with modal interface
 * 
 * Security:
 * - All encryption happens on the client side
 * - Server never sees plaintext contact data
 * - Each user has unique encryption keys derived from their wallet
 * 
 * Usage:
 * ```tsx
 * import { ContactsModal, AddressAutocomplete, useContacts } from '@/features/contacts';
 * 
 * // In your component
 * const { addContact, contacts } = useContacts();
 * 
 * // Modal for managing contacts
 * <ContactsModal
 *   isOpen={isModalOpen}
 *   onClose={() => setModalOpen(false)}
 *   onSelectContact={handleContactSelect}
 * />
 * 
 * // Auto-complete for address input
 * <AddressAutocomplete
 *   value={recipientAddress}
 *   onChange={setRecipientAddress}
 *   onSelectContact={handleContactSelect}
 * />
 * ```
 */

// Main components
export { ContactsModal } from './components/ContactsModal';
export { AddressAutocomplete, AddressInput } from './components/AddressAutocomplete';
export { SendModal } from './components/SendModal';

// Hooks
export { useContacts } from './hooks/useContacts';

// Utilities
export {
  deriveEncryptionKey,
  encryptContactData,
  decryptContactData,
  encryptName,
  encryptAddress,
  decryptName,
  decryptAddress,
  isValidWalletAddress,
  isValidContactName,
  generateContactId,
} from './utils/encryption';

export {
  getContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  searchContacts,
  importContacts,
  exportContacts,
  ContactsApiError,
} from './utils/api';

// Types
export type {
  Contact,
  ContactData,
  EncryptedContactResponse,
  CreateContactRequest,
  UpdateContactRequest,
  ContactsResponse,
  ContactSuggestion,
  EncryptionKey,
} from './types';
