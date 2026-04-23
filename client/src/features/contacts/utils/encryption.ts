/**
 * Client-side encryption utilities for contacts using Web Crypto API (AES-GCM)
 * 
 * Security considerations:
 * - Encryption happens entirely on the client side
 * - Server never sees plaintext contact names or addresses
 * - Each user has their own encryption key derived from their wallet
 * - Uses AES-GCM for authenticated encryption
 */

import { ContactData, EncryptionKey } from '../types';

/**
 * Encryption configuration
 */
const ENCRYPTION_ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits for GCM

/**
 * Generate an encryption key from a user's wallet address
 * Uses PBKDF2 to derive a deterministic key from the wallet address
 * 
 * @param walletAddress User's wallet address
 * @returns Promise<CryptoKey> Derived encryption key
 */
export async function deriveEncryptionKey(walletAddress: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const walletBytes = encoder.encode(walletAddress.toLowerCase().trim());
  
  // Use a fixed salt for deterministic key derivation
  // In production, this could be enhanced with user-specific salts
  const salt = encoder.encode('stellar-yield-contacts-salt-v1');
  
  // Import the wallet address as a key material
  const baseKey = await crypto.subtle.importKey(
    'raw',
    walletBytes,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  
  // Derive the actual encryption key
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    {
      name: ENCRYPTION_ALGORITHM,
      length: KEY_LENGTH,
    },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Generate a random initialization vector for GCM
 * 
 * @returns Uint8Array Random IV
 */
export function generateIV(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(IV_LENGTH));
}

/**
 * Encrypt contact data using AES-GCM
 * 
 * @param data Contact data to encrypt
 * @param key Encryption key
 * @returns Promise<{ encryptedData: string; iv: string }> Base64 encoded encrypted data and IV
 */
export async function encryptContactData(
  data: ContactData,
  key: CryptoKey
): Promise<{ encryptedData: string; iv: string }> {
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(JSON.stringify(data));
  const iv = generateIV();
  
  try {
    const encryptedBuffer = await crypto.subtle.encrypt(
      {
        name: ENCRYPTION_ALGORITHM,
        iv,
      },
      key,
      dataBytes
    );
    
    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encryptedBuffer.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encryptedBuffer), iv.length);
    
    return {
      encryptedData: btoa(String.fromCharCode(...combined)),
      iv: btoa(String.fromCharCode(...iv)),
    };
  } catch (error) {
    throw new Error(`Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Decrypt contact data using AES-GCM
 * 
 * @param encryptedData Base64 encoded encrypted data (includes IV)
 * @param key Decryption key
 * @returns Promise<ContactData> Decrypted contact data
 */
export async function decryptContactData(
  encryptedData: string,
  key: CryptoKey
): Promise<ContactData> {
  try {
    // Decode base64 and extract IV and encrypted data
    const combined = new Uint8Array(
      atob(encryptedData).split('').map(char => char.charCodeAt(0))
    );
    
    const iv = combined.slice(0, IV_LENGTH);
    const encrypted = combined.slice(IV_LENGTH);
    
    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: ENCRYPTION_ALGORITHM,
        iv,
      },
      key,
      encrypted
    );
    
    const decoder = new TextDecoder();
    const decryptedJson = decoder.decode(decryptedBuffer);
    
    return JSON.parse(decryptedJson) as ContactData;
  } catch (error) {
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Encrypt just the name field
 * 
 * @param name Contact name to encrypt
 * @param key Encryption key
 * @returns Promise<string> Base64 encoded encrypted name
 */
export async function encryptName(name: string, key: CryptoKey): Promise<string> {
  const { encryptedData } = await encryptContactData({ name, address: '' }, key);
  return encryptedData;
}

/**
 * Encrypt just the address field
 * 
 * @param address Contact address to encrypt
 * @param key Encryption key
 * @returns Promise<string> Base64 encoded encrypted address
 */
export async function encryptAddress(address: string, key: CryptoKey): Promise<string> {
  const { encryptedData } = await encryptContactData({ name: '', address }, key);
  return encryptedData;
}

/**
 * Decrypt just the name field
 * 
 * @param encryptedName Base64 encoded encrypted name
 * @param key Decryption key
 * @returns Promise<string> Decrypted name
 */
export async function decryptName(encryptedName: string, key: CryptoKey): Promise<string> {
  const data = await decryptContactData(encryptedName, key);
  return data.name;
}

/**
 * Decrypt just the address field
 * 
 * @param encryptedAddress Base64 encoded encrypted address
 * @param key Decryption key
 * @returns Promise<string> Decrypted address
 */
export async function decryptAddress(encryptedAddress: string, key: CryptoKey): Promise<string> {
  const data = await decryptContactData(encryptedAddress, key);
  return data.address;
}

/**
 * Validate wallet address format
 * 
 * @param address Wallet address to validate
 * @returns boolean True if valid address format
 */
export function isValidWalletAddress(address: string): boolean {
  // Basic validation for Ethereum-like addresses
  // Can be extended based on specific blockchain requirements
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validate contact name
 * 
 * @param name Contact name to validate
 * @returns boolean True if valid name
 */
export function isValidContactName(name: string): boolean {
  return name.trim().length > 0 && name.length <= 100;
}

/**
 * Generate a unique ID for new contacts
 * 
 * @returns string Unique ID
 */
export function generateContactId(): string {
  return `contact_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
