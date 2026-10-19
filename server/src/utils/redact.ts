/**
 * redact.ts — Issue #1181
 *
 * Privacy-safe error reporting utilities for wallet and contact failures.
 * Replaces sensitive values (addresses, names, hashes) with safe identifiers
 * so error reports are useful for debugging without leaking PII.
 */

// Stellar G-prefixed wallet addresses (32-56 chars after G)
const STELLAR_ADDRESS_PATTERN = /\bG[A-Z2-7]{25,55}\b/g;

// Transaction hashes (64-char hex strings)
const TX_HASH_PATTERN = /\b[A-Fa-f0-9]{64}\b/g;

// Encrypted data blobs (base64-like strings > 40 chars)
const ENCRYPTED_BLOB_PATTERN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

// Email addresses
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

// Private keys (S-prefixed Stellar secrets or sk- prefixed API keys)
const PRIVATE_KEY_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9]{20,}\b/g;

/**
 * Masked representation of a Stellar address.
 * Preserves first 4 and last 4 characters for debugging context.
 */
function maskAddress(address: string): string {
  if (address.length <= 10) return "G****";
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Masked representation of a transaction hash.
 * Preserves first 6 and last 4 characters.
 */
function maskTxHash(hash: string): string {
  if (hash.length <= 12) return "****";
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

/**
 * Redacts sensitive data from an error message string.
 * Replaces wallet addresses, tx hashes, encrypted blobs, emails,
 * private keys, and API keys with safe masked equivalents.
 */
export function redactSensitiveData(input: string): string {
  if (!input || typeof input !== "string") return input;

  let result = input;

  // Redact private keys first (before address pattern catches them)
  result = result.replace(PRIVATE_KEY_PATTERN, "S****");
  result = result.replace(API_KEY_PATTERN, "sk-****");

  // Redact Stellar addresses (G-prefixed)
  result = result.replace(STELLAR_ADDRESS_PATTERN, (match) => maskAddress(match));

  // Redact transaction hashes
  result = result.replace(TX_HASH_PATTERN, (match) => maskTxHash(match));

  // Redact encrypted blobs
  result = result.replace(ENCRYPTED_BLOB_PATTERN, "****");

  // Redact email addresses
  result = result.replace(EMAIL_PATTERN, "***@***");

  return result;
}

/**
 * Creates a redacted copy of an error for safe logging.
 * Preserves error category fields (code, name, phase) while
 * redacting the message and stack.
 */
export interface RedactedError {
  name: string;
  message: string;
  stack?: string;
  code?: number | string;
  phase?: string;
  timestamp: string;
}

export function redactErrorForLog(error: unknown): RedactedError {
  const timestamp = new Date().toISOString();

  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: redactSensitiveData(error.message),
      stack: error.stack ? redactSensitiveData(error.stack) : undefined,
      timestamp,
    };
  }

  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown>;
    return {
      name: typeof err.name === "string" ? err.name : "UnknownError",
      message: redactSensitiveData(
        typeof err.message === "string" ? err.message : String(error),
      ),
      code: typeof err.code === "number" || typeof err.code === "string" ? err.code : undefined,
      phase: typeof err.phase === "string" ? err.phase : undefined,
      timestamp,
    };
  }

  return {
    name: "UnknownError",
    message: redactSensitiveData(String(error)),
    timestamp,
  };
}

/**
 * Redacts a wallet address for use in log messages.
 * Returns a category-safe identifier that preserves debugging context
 * without exposing the full address.
 */
export function safeWalletId(walletAddress: string): string {
  if (!walletAddress || walletAddress.length < 8) return "wallet:unknown";
  return `wallet:${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
}

/**
 * Redacts a contact identifier for use in log messages.
 */
export function safeContactId(contactId: string): string {
  if (!contactId) return "contact:unknown";
  return `contact:${contactId.slice(0, 8)}`;
}

/**
 * Wraps console.error calls with privacy-safe logging.
 * Use this for wallet and contact failure reporting.
 */
export function safeLogError(
  context: string,
  error: unknown,
  extraFields?: Record<string, unknown>,
): void {
  const redacted = redactErrorForLog(error);
  console.error(`[${context}]`, {
    ...redacted,
    ...extraFields,
  });
}
