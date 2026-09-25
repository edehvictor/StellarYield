import type { Contact, ContactData, ContactSuggestion } from '../types';
import { decryptContactData } from './encryption';

export interface DecryptedContact {
  id: string;
  name: string;
  address: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContactSearchResult {
  contacts: DecryptedContact[];
  query: string;
  totalDecrypted: number;
  failedDecryptions: number;
}

export type SearchableField = 'name' | 'address';

const DEFAULT_SEARCHABLE_FIELDS: SearchableField[] = ['name', 'address'];

export async function decryptContacts(
  encryptedContacts: Contact[],
  decryptionKey: CryptoKey,
): Promise<{ decrypted: DecryptedContact[]; failedCount: number }> {
  const decrypted: DecryptedContact[] = [];
  let failedCount = 0;

  const results = await Promise.allSettled(
    encryptedContacts.map(async (contact) => {
      const nameData = await decryptContactData(contact.encryptedName, decryptionKey);
      const addressData = await decryptContactData(contact.encryptedAddress, decryptionKey);
      return {
        id: contact.id,
        name: nameData.name,
        address: addressData.address,
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt,
      };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      decrypted.push(result.value);
    } else {
      failedCount++;
    }
  }

  return { decrypted, failedCount };
}

export function filterContacts(
  contacts: DecryptedContact[],
  query: string,
  fields: SearchableField[] = DEFAULT_SEARCHABLE_FIELDS,
): DecryptedContact[] {
  const normalizedQuery = query.toLowerCase().trim();

  if (normalizedQuery === '') {
    return contacts;
  }

  return contacts.filter((contact) => {
    for (const field of fields) {
      const value = contact[field];
      if (value && value.toLowerCase().includes(normalizedQuery)) {
        return true;
      }
    }
    return false;
  });
}

export async function searchDecryptedContacts(
  encryptedContacts: Contact[],
  query: string,
  decryptionKey: CryptoKey,
  fields?: SearchableField[],
): Promise<ContactSearchResult> {
  const { decrypted, failedCount } = await decryptContacts(encryptedContacts, decryptionKey);
  const filtered = filterContacts(decrypted, query, fields);

  return {
    contacts: filtered,
    query,
    totalDecrypted: decrypted.length,
    failedDecryptions: failedCount,
  };
}

export function toContactSuggestions(contacts: DecryptedContact[]): ContactSuggestion[] {
  return contacts.map((c) => ({
    id: c.id,
    name: c.name,
    address: c.address,
    displayText: c.name ? `${c.name} (${truncateAddress(c.address)})` : c.address,
  }));
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
