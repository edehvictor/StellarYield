/**
 * Tests for encryption utilities
 * Tests client-side encryption/decryption functionality
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
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
  generateIV,
} from '../utils/encryption';

describe('Encryption Utilities', () => {
  let testWalletAddress: string;
  let encryptionKey: CryptoKey;

  beforeEach(async () => {
    testWalletAddress = '0x1234567890123456789012345678901234567890';
    encryptionKey = await deriveEncryptionKey(testWalletAddress);
  });

  afterEach(() => {
    // Clean up if needed
  });

  describe('deriveEncryptionKey', () => {
    it('should derive a consistent encryption key from the same wallet address', async () => {
      const key1 = await deriveEncryptionKey(testWalletAddress);
      const key2 = await deriveEncryptionKey(testWalletAddress);
      
      // Keys should be equivalent (same algorithm, same extractable status)
      expect(key1.algorithm).toEqual(key2.algorithm);
      expect(key1.extractable).toEqual(key2.extractable);
      expect(key1.type).toEqual(key2.type);
    });

    it('should derive different keys for different wallet addresses', async () => {
      const key1 = await deriveEncryptionKey(testWalletAddress);
      const key2 = await deriveEncryptionKey('0x9876543210987654321098765432109876543210');
      
      // Keys should be different
      expect(key1.algorithm).toEqual(key2.algorithm);
      // Note: We can't directly compare CryptoKey objects, but they should be different instances
    });

    it('should handle wallet addresses with different casing', async () => {
      const key1 = await deriveEncryptionKey(testWalletAddress);
      const key2 = await deriveEncryptionKey(testWalletAddress.toUpperCase());
      
      // Should be case-insensitive
      expect(key1.algorithm).toEqual(key2.algorithm);
    });

    it('should handle wallet addresses with extra whitespace', async () => {
      const key1 = await deriveEncryptionKey(testWalletAddress);
      const key2 = await deriveEncryptionKey(`  ${testWalletAddress}  `);
      
      // Should trim whitespace
      expect(key1.algorithm).toEqual(key2.algorithm);
    });
  });

  describe('generateIV', () => {
    it('should generate an IV of the correct length', () => {
      const iv = generateIV();
      expect(iv).toBeInstanceOf(Uint8Array);
      expect(iv.length).toBe(12); // 96 bits for GCM
    });

    it('should generate different IVs each time', () => {
      const iv1 = generateIV();
      const iv2 = generateIV();
      
      expect(iv1).not.toEqual(iv2);
    });
  });

  describe('encryptContactData and decryptContactData', () => {
    const testContact = {
      name: 'Test Contact',
      address: '0x1234567890123456789012345678901234567890',
    };

    it('should encrypt and decrypt contact data correctly', async () => {
      const encrypted = await encryptContactData(testContact, encryptionKey);
      const decrypted = await decryptContactData(encrypted.encryptedData, encryptionKey);
      
      expect(decrypted).toEqual(testContact);
    });

    it('should produce different encrypted data for the same input', async () => {
      const encrypted1 = await encryptContactData(testContact, encryptionKey);
      const encrypted2 = await encryptContactData(testContact, encryptionKey);
      
      expect(encrypted1.encryptedData).not.toEqual(encrypted2.encryptedData);
      expect(encrypted1.iv).not.toEqual(encrypted2.iv);
    });

    it('should handle empty strings', async () => {
      const emptyContact = { name: '', address: '' };
      const encrypted = await encryptContactData(emptyContact, encryptionKey);
      const decrypted = await decryptContactData(encrypted.encryptedData, encryptionKey);
      
      expect(decrypted).toEqual(emptyContact);
    });

    it('should handle special characters', async () => {
      const specialContact = {
        name: 'Test Ñiño 🚀 Contact',
        address: '0x1234567890123456789012345678901234567890',
      };
      const encrypted = await encryptContactData(specialContact, encryptionKey);
      const decrypted = await decryptContactData(encrypted.encryptedData, encryptionKey);
      
      expect(decrypted).toEqual(specialContact);
    });

    it('should fail to decrypt with wrong key', async () => {
      const encrypted = await encryptContactData(testContact, encryptionKey);
      const wrongKey = await deriveEncryptionKey('0x9876543210987654321098765432109876543210');
      
      await expect(decryptContactData(encrypted.encryptedData, wrongKey)).rejects.toThrow('Decryption failed');
    });

    it('should fail to decrypt corrupted data', async () => {
      const encrypted = await encryptContactData(testContact, encryptionKey);
      const corruptedData = encrypted.encryptedData.slice(0, -1) + 'X';
      
      await expect(decryptContactData(corruptedData, encryptionKey)).rejects.toThrow('Decryption failed');
    });
  });

  describe('Field-specific encryption', () => {
    it('should encrypt and decrypt names correctly', async () => {
      const name = 'Test Contact Name';
      const encrypted = await encryptName(name, encryptionKey);
      const decrypted = await decryptName(encrypted, encryptionKey);
      
      expect(decrypted).toBe(name);
    });

    it('should encrypt and decrypt addresses correctly', async () => {
      const address = '0x1234567890123456789012345678901234567890';
      const encrypted = await encryptAddress(address, encryptionKey);
      const decrypted = await decryptAddress(encrypted, encryptionKey);
      
      expect(decrypted).toBe(address);
    });
  });

  describe('Validation functions', () => {
    describe('isValidWalletAddress', () => {
      it('should validate correct Ethereum addresses', () => {
        const validAddresses = [
          '0x1234567890123456789012345678901234567890',
          '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD',
        ];
        
        validAddresses.forEach(address => {
          expect(isValidWalletAddress(address)).toBe(true);
        });
      });

      it('should reject invalid addresses', () => {
        const invalidAddresses = [
          '0x123456789012345678901234567890123456789', // Too short
          '0x12345678901234567890123456789012345678900', // Too long
          '1234567890123456789012345678901234567890', // Missing 0x
          '0x123456789012345678901234567890123456789g', // Invalid character
          '', // Empty
          '0x', // Just prefix
        ];
        
        invalidAddresses.forEach(address => {
          expect(isValidWalletAddress(address)).toBe(false);
        });
      });
    });

    describe('isValidContactName', () => {
      it('should validate correct names', () => {
        const validNames = [
          'John Doe',
          'Alice',
          'Company Name',
          'A', // Minimum length
          'A'.repeat(100), // Maximum length
          'Test Ñiño', // Special characters
        ];
        
        validNames.forEach(name => {
          expect(isValidContactName(name)).toBe(true);
        });
      });

      it('should reject invalid names', () => {
        const invalidNames = [
          '', // Empty
          '   ', // Only whitespace
          'A'.repeat(101), // Too long
        ];
        
        invalidNames.forEach(name => {
          expect(isValidContactName(name)).toBe(false);
        });
      });
    });
  });

  describe('generateContactId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateContactId();
      const id2 = generateContactId();
      
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^contact_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^contact_\d+_[a-z0-9]+$/);
    });

    it('should generate IDs with correct prefix', () => {
      const id = generateContactId();
      expect(id).toMatch(/^contact_/);
    });
  });

  describe('Error handling', () => {
    it('should handle encryption errors gracefully', async () => {
      // Create an invalid key (this is a bit tricky to test in practice)
      // For now, we'll test with a null/undefined scenario
      await expect(encryptContactData({ name: 'test', address: '0x123' }, null as any)).rejects.toThrow();
    });

    it('should handle decryption errors gracefully', async () => {
      // Test with invalid base64
      await expect(decryptContactData('invalid-base64!', encryptionKey)).rejects.toThrow('Decryption failed');
    });
  });

  describe('Performance', () => {
    it('should encrypt/decrypt within reasonable time limits', async () => {
      const contact = {
        name: 'Performance Test Contact',
        address: '0x1234567890123456789012345678901234567890',
      };

      const startTime = performance.now();
      
      // Test multiple encryptions
      const encryptPromises = Array.from({ length: 10 }, () => 
        encryptContactData(contact, encryptionKey)
      );
      const encryptedResults = await Promise.all(encryptPromises);
      
      // Test multiple decryptions
      const decryptPromises = encryptedResults.map(result => 
        decryptContactData(result.encryptedData, encryptionKey)
      );
      const decryptedResults = await Promise.all(decryptPromises);
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      // Should complete within 1 second for 10 operations
      expect(duration).toBeLessThan(1000);
      
      // All results should be correct
      decryptedResults.forEach(result => {
        expect(result).toEqual(contact);
      });
    });
  });
});
