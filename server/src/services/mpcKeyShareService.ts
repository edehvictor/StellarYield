import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32; // 256 bits

/**
 * Derive a 32-byte Buffer from the raw key material in MPC_ENCRYPTION_KEY.
 * Accepts a 64-char hex string (most common) or any UTF-8 string (hashed to 32 bytes).
 */
function getEncryptionKey(): Buffer {
  const raw = process.env.MPC_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "MPC_ENCRYPTION_KEY environment variable is not set. " +
        "Set it to a 64-character hex string (32 bytes).",
    );
  }
  // Allow a hex-encoded key for easy configuration
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  // Fall back: SHA-256 hash of the raw string to obtain exactly 32 bytes
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export interface EncryptedBlob {
  iv: string; // hex
  authTag: string; // hex
  ciphertext: string; // hex
}

function encrypt(plaintext: string): EncryptedBlob {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Unexpected GCM auth tag length.");
  }

  return {
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: encrypted.toString("hex"),
  };
}

function decrypt(blob: EncryptedBlob): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(blob.iv, "hex");
  const authTag = Buffer.from(blob.authTag, "hex");
  const ciphertext = Buffer.from(blob.ciphertext, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * In-memory store: shareId → EncryptedBlob.
 * In production this would be replaced by a secure HSM or secrets manager.
 */
const store = new Map<string, EncryptedBlob>();

/**
 * Store a raw key share encrypted at rest.
 * Subsequent calls for the same shareId overwrite the previous entry.
 */
export function storeShare(shareId: string, rawShare: string): void {
  if (!shareId) throw new Error("shareId must not be empty.");
  if (!rawShare) throw new Error("rawShare must not be empty.");
  store.set(shareId, encrypt(rawShare));
}

/**
 * Retrieve and decrypt a stored key share.
 * Throws if the shareId does not exist.
 */
export function retrieveShare(shareId: string): string {
  const blob = store.get(shareId);
  if (!blob) {
    throw new Error(`Key share not found for shareId: ${shareId}`);
  }
  return decrypt(blob);
}

/**
 * Atomically replace the share for shareId with newRawShare.
 * Throws if the shareId does not exist (rotate implies a pre-existing share).
 */
export function rotateShare(shareId: string, newRawShare: string): void {
  if (!store.has(shareId)) {
    throw new Error(
      `Cannot rotate: key share not found for shareId: ${shareId}`,
    );
  }
  if (!newRawShare) throw new Error("newRawShare must not be empty.");
  store.set(shareId, encrypt(newRawShare));
}

/**
 * Return an encrypted backup payload for the share.
 * The backup itself is the EncryptedBlob — it is safe to transmit but
 * must be kept confidential to prevent offline brute-force.
 */
export function backupShare(shareId: string): EncryptedBlob {
  const blob = store.get(shareId);
  if (!blob) {
    throw new Error(`Cannot backup: key share not found for shareId: ${shareId}`);
  }
  // Return a copy to prevent accidental external mutation
  return { ...blob };
}

/**
 * Restore a share from a backup payload previously returned by backupShare().
 * Validates that the payload can be decrypted before persisting.
 */
export function restoreShare(shareId: string, backupPayload: EncryptedBlob): void {
  if (!shareId) throw new Error("shareId must not be empty.");
  // Verify integrity before storing
  decrypt(backupPayload); // will throw if tampered
  store.set(shareId, { ...backupPayload });
}

/**
 * Check whether a share exists (without decrypting).
 */
export function hasShare(shareId: string): boolean {
  return store.has(shareId);
}

/**
 * Clear all shares — intended for test teardown only.
 */
export function _clearAllShares(): void {
  store.clear();
}

export const _encryptForTesting = encrypt;
export const _decryptForTesting = decrypt;
