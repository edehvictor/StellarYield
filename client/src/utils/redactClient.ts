/**
 * redactClient.ts — Issue #1181
 *
 * Client-side privacy-safe error utilities.
 * Redacts wallet addresses, transaction hashes, and other PII from
 * error strings before they are copied to clipboard or logged.
 */

// Stellar G-prefixed wallet addresses
const STELLAR_ADDRESS_PATTERN = /\bG[A-Z2-7]{25,55}\b/g;

// Transaction hashes (64-char hex)
const TX_HASH_PATTERN = /\b[A-Fa-f0-9]{64}\b/g;

// Encrypted data blobs
const ENCRYPTED_BLOB_PATTERN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

// Email addresses
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

// Private keys
const PRIVATE_KEY_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9]{20,}\b/g;

function maskAddress(address: string): string {
  if (address.length <= 10) return "G****";
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function maskTxHash(hash: string): string {
  if (hash.length <= 12) return "****";
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

/**
 * Redacts sensitive data from a string for safe clipboard copy and logging.
 */
export function redactSensitiveData(input: string): string {
  if (!input || typeof input !== "string") return input;

  let result = input;
  result = result.replace(PRIVATE_KEY_PATTERN, "S****");
  result = result.replace(API_KEY_PATTERN, "sk-****");
  result = result.replace(STELLAR_ADDRESS_PATTERN, (match) => maskAddress(match));
  result = result.replace(TX_HASH_PATTERN, (match) => maskTxHash(match));
  result = result.replace(ENCRYPTED_BLOB_PATTERN, "****");
  result = result.replace(EMAIL_PATTERN, "***@***");
  return result;
}

/**
 * Creates a redacted payload for clipboard copy from a DecodedError.
 * Preserves title, code, phase, message, and suggestion (user-facing)
 * while redacting the raw developer log.
 */
export function buildRedactedCopyPayload(params: {
  title: string;
  code?: number;
  phase?: string;
  message: string;
  suggestion: string;
  raw: string;
  walletConnected?: boolean;
  networkHealthy?: boolean;
}): string {
  return [
    `title=${params.title}`,
    `code=${params.code ?? "unknown"}`,
    `phase=${params.phase ?? "unknown"}`,
    `walletConnected=${params.walletConnected ?? "unknown"}`,
    `networkHealthy=${params.networkHealthy ?? "unknown"}`,
    `message=${params.message}`,
    `suggestion=${params.suggestion}`,
    `raw=${redactSensitiveData(params.raw)}`,
  ].join("\n");
}
