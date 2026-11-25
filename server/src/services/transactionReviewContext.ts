/**
 * TransactionReviewContext
 *
 * Explicit context captured when a transaction review begins.
 * Every relevant read and write during the review must use this
 * same context. Mismatches are rejected rather than silently
 * applying results from a different network, ledger, or version.
 *
 * Invariants:
 * - context is captured once at review start
 * - all subsequent operations use the captured context
 * - context is validated before execution/mutation
 * - mismatches produce clear, actionable errors
 *
 * The context includes:
 * - networkPassphrase: Identifies the Stellar network (testnet/mainnet)
 * - rpcUrl: The Soroban RPC endpoint URL
 * - ledgerSequence: The ledger version/sequence at review start
 * - transactionVersion: An opaque version identifier for the transaction
 */

export type NetworkPassphrase =
  | "Test SDF Network ; September 2015"
  | "Public Global Stellal Network ; November 2015"
  | "Nonprofit Standard Network ; December 2023";

export interface TransactionReviewContext {
  /** The network passphrase identifying the Stellar network */
  networkPassphrase: NetworkPassphrase;
  /** The Soroban RPC URL used for the review */
  rpcUrl: string;
  /** The ledger sequence number at the time the review began */
  ledgerSequence: number;
  /** An opaque version identifier for the transaction being reviewed */
  transactionVersion: string;
  /** Timestamp when the context was captured */
  capturedAt: number;
}

/**
 * Creates a TransactionReviewContext from the current environment.
 * Captures the network passphrase, RPC URL, and current ledger state.
 * @param ledgerSequence - The ledger sequence number at review start (defaults to 0)
 * @param transactionVersion - An opaque version identifier (defaults to 'pending')
 */
export function createTransactionReviewContext(
  networkPassphrase: NetworkPassphrase,
  rpcUrl: string,
  ledgerSequence?: number,
  transactionVersion?: string
): TransactionReviewContext {
  return {
    networkPassphrase,
    rpcUrl,
    ledgerSequence: ledgerSequence ?? 0,
    transactionVersion: transactionVersion ?? "pending",
    capturedAt: Date.now(),
  };
}

/**
 * Validates that a given context matches the expected context.
 * Returns an error message if there is a mismatch, or null if valid.
 */
export function validateTransactionReviewContext(
  context: TransactionReviewContext,
  expected: TransactionReviewContext
): string | null {
  if (context.networkPassphrase !== expected.networkPassphrase) {
    return `Network mismatch: expected "${expected.networkPassphrase}", got "${context.networkPassphrase}"`;
  }

  if (context.rpcUrl !== expected.rpcUrl) {
    return `RPC URL mismatch: expected "${expected.rpcUrl}", got "${context.rpcUrl}"`;
  }

  if (context.ledgerSequence !== expected.ledgerSequence) {
    return `Ledger sequence mismatch: expected ${expected.ledgerSequence}, got ${context.ledgerSequence}`;
  }

  if (context.transactionVersion !== expected.transactionVersion) {
    return `Transaction version mismatch: expected "${expected.transactionVersion}", got "${context.transactionVersion}"`;
  }

  return null;
}

/**
 * Error codes for context validation failures.
 */
export enum ContextValidationErrorCode {
  NETWORK_MISMATCH = "NETWORK_MISMATCH",
  RPC_URL_MISMATCH = "RPC_URL_MISMATCH",
  LEDGER_SEQUENCE_MISMATCH = "LEDGER_SEQUENCE_MISMATCH",
  TRANSACTION_VERSION_MISMATCH = "TRANSACTION_VERSION_MISMATCH",
}

/**
 * A structured error returned when transaction review context validation fails.
 */
export interface ContextValidationError {
  code: ContextValidationErrorCode;
  message: string;
  /** The actual context that was presented */
  actual: TransactionReviewContext;
  /** The expected context that should be used */
  expected: TransactionReviewContext;
}

/**
 * Creates a ContextValidationError from a mismatch string.
 */
export function createContextValidationError(
  code: ContextValidationErrorCode,
  message: string,
  actual: TransactionReviewContext,
  expected: TransactionReviewContext
): ContextValidationError {
  return { code, message, actual, expected };
}

export default {
  createTransactionReviewContext,
  validateTransactionReviewContext,
  ContextValidationErrorCode,
  createContextValidationError,
};