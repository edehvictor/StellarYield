/**
 * Relayer nonce (sequence-number) conflict handling (#1153).
 *
 * A nonce conflict happens when the relayer's or the inner transaction's
 * source-account sequence number no longer matches what the network
 * expects by the time a transaction is submitted — typically because
 * another transaction from the same account landed first. Left
 * unclassified, this surfaces as an opaque 500 alongside every other
 * failure, giving the caller no signal about whether a retry is safe.
 *
 * This module:
 *  - Detects a nonce/sequence conflict from a thrown error or a decoded
 *    Soroban RPC `sendTransaction` response, mapped to a stable
 *    `NONCE_CONFLICT` status distinct from a generic failure.
 *  - Decides whether the *transaction being relayed* is safe to retry
 *    after a nonce conflict. Retrying means re-submitting after refreshing
 *    the sequence number; for anything that moves funds, blindly retrying
 *    could double-execute if the original submission actually landed
 *    despite the conflicting response. The only transactions this codebase
 *    can positively identify as duplicate-safe are ones
 *    `computeTransactionFingerprintForTx` can fingerprint — currently just
 *    simple `payment` operations (see relayer.ts). Everything else
 *    (Soroban `invokeHostFunction` calls — deposits, withdrawals, zaps,
 *    rebalances) is NOT retried: we cannot prove the prior attempt didn't
 *    already land, so retrying could double-execute a fund movement.
 *    Defaults to unsafe/no-retry whenever eligibility can't be established.
 */

import type { Transaction } from "@stellar/stellar-sdk";

/**
 * Terminal, non-success outcome of a nonce-conflict-aware submission.
 * `SUCCESS` is represented separately by `submitWithNonceConflictHandling`'s
 * `{ status: "SUCCESS"; result }` branch so the two are structurally
 * distinguishable — `NonceConflictResolution` never carries `status: "SUCCESS"`.
 *
 *  - `RETRY_EXHAUSTED` — every retry attempt also hit a nonce conflict.
 *  - `UNSAFE_TO_RETRY` — a nonce conflict was detected but this transaction
 *    type is not eligible for an automatic retry.
 *  - `FAILED` — a non-nonce-conflict error occurred.
 */
export type RelayerSubmissionStatus = "RETRY_EXHAUSTED" | "UNSAFE_TO_RETRY" | "FAILED";

/** Stable, machine-readable code for a nonce-conflict-specific failure. */
export const NONCE_CONFLICT_CODE = "RELAYER_NONCE_CONFLICT" as const;

/** One recorded attempt at relaying/submitting a transaction. */
export interface RelayAttemptRecord {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  outcome: "success" | "nonce_conflict" | "error";
  error?: string;
}

export interface NonceConflictResolution {
  status: RelayerSubmissionStatus;
  /** True once a retry attempt actually ran (regardless of its outcome). */
  retried: boolean;
  /** True when the transaction type is eligible for an automatic retry. */
  retryEligible: boolean;
  /** All attempts made, in order, including the initial one. */
  attempts: RelayAttemptRecord[];
  /** Stable code for API responses; only set for nonce-conflict-shaped outcomes. */
  code?: typeof NONCE_CONFLICT_CODE;
  /** Human-readable, user-facing explanation — always present on a non-SUCCESS status. */
  reason?: string;
}

/**
 * Horizon/Soroban RPC "bad sequence" result codes. `txBadSeq` covers the
 * classic Horizon submission response; Soroban RPC's `sendTransaction`
 * decodes to the same `TransactionResult` shape via `errorResult`.
 */
const BAD_SEQUENCE_RESULT_CODES = new Set(["txBadSeq", "tx_bad_seq"]);

interface DecodedResultLike {
  result?: () => { switch?: () => { name?: string } };
}

/**
 * True when a decoded Soroban RPC `sendTransaction` `errorResult` (an
 * `xdr.TransactionResult`) indicates a sequence-number conflict.
 */
export function isNonceConflictResult(errorResult: unknown): boolean {
  if (!errorResult || typeof errorResult !== "object") return false;
  const decoded = errorResult as DecodedResultLike;
  try {
    const switchName = decoded.result?.()?.switch?.()?.name;
    return typeof switchName === "string" && BAD_SEQUENCE_RESULT_CODES.has(switchName);
  } catch {
    return false;
  }
}

interface CodedErrorLike {
  message?: unknown;
  errorResult?: unknown;
  errorResultXdr?: unknown;
}

/**
 * True when a thrown error (or a `sendTransaction`-shaped response coerced
 * to an error) represents a nonce/sequence-number conflict.
 *
 * Checks, in order: a decoded `errorResult` (most precise — Horizon/Soroban
 * RPC's own classification), then falls back to matching the well-known
 * result-code strings in the error message (covers errors that stringify
 * the XDR before throwing, matching the string-matching convention already
 * used by `RebalanceExecutorService.classifyError`).
 */
export function isNonceConflictError(error: unknown): boolean {
  if (!error) return false;
  const source = error as CodedErrorLike;

  if (isNonceConflictResult(source.errorResult)) return true;

  const haystack = [
    typeof source.message === "string" ? source.message : "",
    typeof source.errorResultXdr === "string" ? source.errorResultXdr : "",
  ]
    .join(" ")
    .toLowerCase();

  return (
    haystack.includes("txbadseq") ||
    haystack.includes("tx_bad_seq") ||
    haystack.includes("bad sequence") ||
    (haystack.includes("sequence") && haystack.includes("conflict"))
  );
}

/**
 * Whether `tx` is eligible for an automatic retry after a nonce conflict.
 *
 * Delegates to the caller-supplied fingerprint function so this stays in
 * sync with `computeTransactionFingerprintForTx` in relayer.ts without a
 * circular import: only a transaction that fingerprints (currently: a
 * simple `payment` operation) is provably a single, duplicate-safe economic
 * transaction. Soroban contract invocations (deposits, withdrawals, zaps,
 * rebalances) return `undefined` from the fingerprint function and are
 * therefore never retry-eligible here — defaulting to NOT retrying when
 * safety can't be established.
 */
export function isSafeToRetryAfterNonceConflict(
  tx: Transaction,
  fingerprintFn: (tx: Transaction) => string | undefined,
): boolean {
  return fingerprintFn(tx) !== undefined;
}

export interface RetryAfterNonceConflictOptions {
  /** Max additional attempts after the first (default 2, i.e. 3 attempts total). */
  maxRetries?: number;
  /** Delay between attempts in ms (default 0 — tests/production can override). */
  retryDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 0;

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Run `submit` (a single submission attempt) with nonce-conflict-aware
 * retry. Only retries when `retryEligible` is true; otherwise a detected
 * nonce conflict is reported as `UNSAFE_TO_RETRY` with a clear reason on
 * the first attempt, with no further submissions made.
 *
 * `submit` should throw (or reject) for a failed attempt; the thrown value
 * is inspected with `isNonceConflictError`. Any non-nonce-conflict error is
 * surfaced immediately (unretried) as `FAILED`.
 */
export async function submitWithNonceConflictHandling<T>(
  submit: () => Promise<T>,
  options: RetryAfterNonceConflictOptions & { retryEligible: boolean },
): Promise<
  | { status: "SUCCESS"; result: T; attempts: RelayAttemptRecord[] }
  | (NonceConflictResolution & { result?: undefined })
> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const attempts: RelayAttemptRecord[] = [];

  for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber++) {
    const startedAt = new Date().toISOString();
    try {
      const result = await submit();
      attempts.push({
        attempt: attemptNumber,
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: "success",
      });
      return { status: "SUCCESS", result, attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNonceConflict = isNonceConflictError(error);

      attempts.push({
        attempt: attemptNumber,
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: isNonceConflict ? "nonce_conflict" : "error",
        error: message,
      });

      if (!isNonceConflict) {
        return {
          status: "FAILED",
          retried: attemptNumber > 1,
          retryEligible: options.retryEligible,
          attempts,
          reason: message,
        };
      }

      if (!options.retryEligible) {
        return {
          status: "UNSAFE_TO_RETRY",
          retried: false,
          retryEligible: false,
          attempts,
          code: NONCE_CONFLICT_CODE,
          reason:
            "A nonce conflict was detected, but this transaction type cannot be safely " +
            "retried automatically — it moves funds and there is no way to confirm the " +
            "original submission did not already land. Refresh the sequence number and " +
            "resubmit manually after confirming the prior attempt's outcome.",
        };
      }

      if (attemptNumber > maxRetries) {
        return {
          status: "RETRY_EXHAUSTED",
          retried: true,
          retryEligible: true,
          attempts,
          code: NONCE_CONFLICT_CODE,
          reason: `Nonce conflict persisted after ${attemptNumber} attempts. Refresh the sequence number and try again.`,
        };
      }

      await delay(retryDelayMs);
      // loop continues to the next attempt
    }
  }

  // Unreachable in practice (the loop always returns), but keeps the
  // function's return type total for TypeScript.
  return {
    status: "RETRY_EXHAUSTED",
    retried: true,
    retryEligible: options.retryEligible,
    attempts,
    code: NONCE_CONFLICT_CODE,
    reason: "Nonce conflict retry loop exited unexpectedly.",
  };
}
