import { describe, it, expect, beforeEach } from 'vitest';
import {
  decryptContacts,
  filterContacts,
  searchDecryptedContacts,
  toContactSuggestions,
  type DecryptedContact,
} from '../utils/contactSearch';
import { deriveEncryptionKey, encryptContactData } from '../utils/encryption';
import type { Contact } from '../types';

describe('Decrypted Contact Search', () => {
  let encryptionKey: CryptoKey;
  const walletAddress = '0x1234567890123456789012345678901234567890';

  const plainContacts = [
    { name: 'Alice Wonderland', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { name: 'Bob Builder', address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    { name: 'Carol Danvers', address: '0xcccccccccccccccccccccccccccccccccccccccc' },
    { name: 'Dave Grohl', address: '0xdddddddddddddddddddddddddddddddddddddd' },
  ];

  let encryptedContacts: Contact[];

  beforeEach(async () => {
    encryptionKey = await deriveEncryptionKey(walletAddress);
    encryptedContacts = await Promise.all(
      plainContacts.map(async (c, i) => {
        const nameEnc = await encryptContactData({ name: c.name, address: '' }, encryptionKey);
        const addrEnc = await encryptContactData({ name: '', address: c.address }, encryptionKey);
        return {
          id: `contact-${i}`,
          encryptedName: nameEnc.encryptedData,
          encryptedAddress: addrEnc.encryptedData,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        };
      }),
    );
  });

  describe('decryptContacts', () => {
    it('decrypts all contacts successfully', async () => {
      const { decrypted, failedCount } = await decryptContacts(encryptedContacts, encryptionKey);
      expect(decrypted).toHaveLength(4);
      expect(failedCount).toBe(0);
      expect(decrypted[0].name).toBe('Alice Wonderland');
      expect(decrypted[1].name).toBe('Bob Builder');
    });

    it('handles empty contact list', async () => {
      const { decrypted, failedCount } = await decryptContacts([], encryptionKey);
      expect(decrypted).toHaveLength(0);
      expect(failedCount).toBe(0);
    });

    it('counts failed decryptions without throwing', async () => {
      const wrongKey = await deriveEncryptionKey('0x9876543210987654321098765432109876543210');
      const { decrypted, failedCount } = await decryptContacts(encryptedContacts, wrongKey);
      expect(failedCount).toBe(4);
      expect(decrypted).toHaveLength(0);
    });

    it('preserves contact metadata', async () => {
      const { decrypted } = await decryptContacts(encryptedContacts, encryptionKey);
      expect(decrypted[0].id).toBe('contact-0');
      expect(decrypted[0].createdAt).toBe('2025-01-01T00:00:00Z');
    });
  });

  describe('filterContacts', () => {
    const contacts: DecryptedContact[] = plainContacts.map((c, i) => ({
      id: `contact-${i}`,
      name: c.name,
      address: c.address,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    }));

    it('returns all contacts for empty query', () => {
      const results = filterContacts(contacts, '');
      expect(results).toHaveLength(4);
    });

    it('returns all contacts for whitespace-only query', () => {
      const results = filterContacts(contacts, '   ');
      expect(results).toHaveLength(4);
    });

    it('matches by name (case-insensitive)', () => {
      const results = filterContacts(contacts, 'alice');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Alice Wonderland');
    });

    it('matches by partial name', () => {
      const results = filterContacts(contacts, 'wonder');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Alice Wonderland');
    });

    it('matches by address', () => {
      const results = filterContacts(contacts, '0xbbbb');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Bob Builder');
    });

    it('returns empty for no match', () => {
      const results = filterContacts(contacts, 'zzzznonexistent');
      expect(results).toHaveLength(0);
    });

    it('supports filtering by name only', () => {
      const results = filterContacts(contacts, '0xaaaa', ['name']);
      expect(results).toHaveLength(0);
    });

    it('supports filtering by address only', () => {
      const results = filterContacts(contacts, 'Alice', ['address']);
      expect(results).toHaveLength(0);
    });

    it('matches multiple contacts', () => {
      const results = filterContacts(contacts, 'a');
      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('searchDecryptedContacts (end-to-end)', () => {
    it('decrypts and searches by name', async () => {
      const result = await searchDecryptedContacts(encryptedContacts, 'Bob', encryptionKey);
      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0].name).toBe('Bob Builder');
      expect(result.totalDecrypted).toBe(4);
      expect(result.failedDecryptions).toBe(0);
      expect(result.query).toBe('Bob');
    });

    it('decrypts and searches by address', async () => {
      const result = await searchDecryptedContacts(encryptedContacts, '0xcccc', encryptionKey);
      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0].name).toBe('Carol Danvers');
    });

    it('returns all contacts for empty query', async () => {
      const result = await searchDecryptedContacts(encryptedContacts, '', encryptionKey);
      expect(result.contacts).toHaveLength(4);
    });

    it('returns empty when no match', async () => {
      const result = await searchDecryptedContacts(encryptedContacts, 'zzzzz', encryptionKey);
      expect(result.contacts).toHaveLength(0);
      expect(result.totalDecrypted).toBe(4);
    });

    it('reports failed decryptions with wrong key', async () => {
      const wrongKey = await deriveEncryptionKey('0x9876543210987654321098765432109876543210');
      const result = await searchDecryptedContacts(encryptedContacts, 'Alice', wrongKey);
      expect(result.contacts).toHaveLength(0);
      expect(result.failedDecryptions).toBe(4);
    });

    it('respects field restriction', async () => {
      const result = await searchDecryptedContacts(encryptedContacts, 'Alice', encryptionKey, ['address']);
      expect(result.contacts).toHaveLength(0);
    });
  });

  describe('toContactSuggestions', () => {
    const contacts: DecryptedContact[] = [
      {
        id: 'c1',
        name: 'Alice',
        address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      },
      {
        id: 'c2',
        name: '',
        address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      },
    ];

    it('converts decrypted contacts to suggestions', () => {
      const suggestions = toContactSuggestions(contacts);
      expect(suggestions).toHaveLength(2);
      expect(suggestions[0].id).toBe('c1');
      expect(suggestions[0].name).toBe('Alice');
      expect(suggestions[0].displayText).toContain('Alice');
      expect(suggestions[0].displayText).toContain('...');
    });

    it('uses address as displayText when name is empty', () => {
      const suggestions = toContactSuggestions(contacts);
      expect(suggestions[1].displayText).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    });

    it('truncates long addresses in display text', () => {
      const suggestions = toContactSuggestions(contacts);
      expect(suggestions[0].displayText).toMatch(/0xaaaa\.\.\.aaaa/);
    });
  });
});
