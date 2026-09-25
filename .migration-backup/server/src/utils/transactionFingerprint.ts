import { computeChecksum } from "./checksum";

/**
 * Deterministic transaction fingerprinting for duplicate detection (#1319).
 *
 * Computes a stable SHA-256 fingerprint over the semantic fields of a
 * transaction (sender, receiver, amount, asset, memo/nonce, and a
 * timestamp bucket) so that duplicate submissions can be detected before
 * being processed/recorded — independent of encoding differences (e.g. two
 * XDR blobs that differ only in signature order but represent the same
 * economic transaction).
 *
 * Field order never affects the result: fields are serialized in a fixed,
 * explicit order rather than relying on object key order.
 */

/** Default bucket width used to group nearby timestamps into the same fingerprint. */
export const DEFAULT_TIMESTAMP_BUCKET_MS = 60_000; // 1 minute

export interface TransactionFingerprintInput {
  /** Source/sender account address (e.g. Stellar G... public key). */
  sender: string;
  /** Destination/receiver account address. */
  receiver: string;
  /** Amount, as a string to avoid float precision issues (e.g. stroops or decimal amount). */
  amount: string;
  /** Asset code or contract id (e.g. "XLM", "USDC:GA...", or a Soroban asset contract id). */
  asset: string;
  /** Memo or nonce distinguishing otherwise-identical transactions. Optional. */
  memo?: string;
  /** Unix epoch milliseconds for the transaction. Used to derive a timestamp bucket. */
  timestampMs: number;
  /** Bucket width in ms; defaults to {@link DEFAULT_TIMESTAMP_BUCKET_MS}. */
  bucketMs?: number;
}

/**
 * Normalizes a transaction into a canonical, order-independent field record.
 * Exported for callers that want to inspect the canonical form (e.g. for logging).
 */
export function canonicalizeTransaction(
  input: TransactionFingerprintInput
): Record<string, string> {
  const bucketMs = input.bucketMs ?? DEFAULT_TIMESTAMP_BUCKET_MS;
  const timestampBucket = Math.floor(input.timestampMs / bucketMs);

  return {
    sender: input.sender.trim().toLowerCase(),
    receiver: input.receiver.trim().toLowerCase(),
    amount: input.amount.trim(),
    asset: input.asset.trim().toLowerCase(),
    memo: (input.memo ?? "").trim(),
    timestampBucket: String(timestampBucket),
  };
}

/**
 * Computes a deterministic SHA-256 fingerprint for a transaction.
 *
 * Same logical inputs always produce the same hash, regardless of the order
 * fields are supplied in (the canonical form uses a fixed key order, sorted
 * for good measure via {@link computeChecksum}'s stable stringify).
 * Different inputs (even a single differing field) produce a different hash.
 */
export function computeTransactionFingerprint(input: TransactionFingerprintInput): string {
  const canonical = canonicalizeTransaction(input);
  return computeChecksum(
    JSON.stringify(canonical, Object.keys(canonical).sort())
  );
}
