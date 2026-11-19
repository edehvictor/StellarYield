import type { ZapQuoteResponse } from "./types";

export const ZAP_QUOTE_TTL_MS = 60_000;

/** Deterministic user-facing message for an expired zap preview quote. */
export const ZAP_QUOTE_EXPIRED_MESSAGE = "Quote expired. Refresh and try again.";

export interface ZapQuoteFreshnessInput {
  expiresAt?: string;
  quotedAt: string;
}

/**
 * Typed invalidation state for a zap preview quote.
 *
 * - `valid`   — the quote may still be used for display and submission.
 * - `expired` — the quote must be treated as invalidated: submission is
 *   blocked, the preview is flagged, and a fresh quote must be requested.
 */
export type ZapQuoteInvalidation =
  | { status: "valid"; ageMs: number; remainingMs: number }
  | { status: "expired"; ageMs: number; expiredForMs: number };

/**
 * Evaluate whether a zap preview quote has been invalidated by expiry.
 *
 * Rules (mirroring the server's `isQuoteExpired`):
 *  - `expiresAt` present and parseable → expired when `nowMs > expiresAt`
 *    (exclusive boundary: still valid at the exact expiry instant).
 *  - `expiresAt` missing or unparseable → fall back to `quotedAt + TTL`.
 *
 * Pure and deterministic: callers inject `nowMs` so tests can probe the
 * exact boundary without timers.
 */
export function evaluateZapQuoteInvalidation(
  quote: ZapQuoteFreshnessInput,
  nowMs: number = Date.now(),
): ZapQuoteInvalidation {
  const quotedMs = new Date(quote.quotedAt).getTime();
  const ageMs = Number.isFinite(quotedMs) ? nowMs - quotedMs : Number.POSITIVE_INFINITY;

  let expiresMs: number | null = null;
  if (quote.expiresAt && typeof quote.expiresAt === "string") {
    const parsed = new Date(quote.expiresAt).getTime();
    if (Number.isFinite(parsed)) {
      expiresMs = parsed;
    }
  }
  if (expiresMs === null) {
    expiresMs = Number.isFinite(quotedMs) ? quotedMs + ZAP_QUOTE_TTL_MS : Number.NEGATIVE_INFINITY;
  }

  if (nowMs > expiresMs) {
    return { status: "expired", ageMs, expiredForMs: nowMs - expiresMs };
  }
  return { status: "valid", ageMs, remainingMs: expiresMs - nowMs };
}

/**
 * On-chain deadline (Unix seconds) for `zap_deposit_with_deadline`, derived
 * with the same rules as {@link evaluateZapQuoteInvalidation}: the quote's
 * `expiresAt`, else `quotedAt + TTL`, else `nowMs + TTL` when there is no
 * usable quote. Floored to whole seconds, so the contract never accepts a
 * transaction later than the preview would.
 */
export function zapQuoteDeadlineSeconds(
  quote: ZapQuoteFreshnessInput | null,
  nowMs: number = Date.now(),
): bigint {
  let deadlineMs = Number.NaN;
  if (quote) {
    deadlineMs = quote.expiresAt ? new Date(quote.expiresAt).getTime() : Number.NaN;
    if (!Number.isFinite(deadlineMs)) {
      deadlineMs = new Date(quote.quotedAt).getTime() + ZAP_QUOTE_TTL_MS;
    }
  }
  if (!Number.isFinite(deadlineMs)) {
    deadlineMs = nowMs + ZAP_QUOTE_TTL_MS;
  }
  return BigInt(Math.floor(deadlineMs / 1000));
}

/** Returns true when a zap quote should be treated as stale. */
export function isZapQuoteExpired(
  quote: ZapQuoteFreshnessInput,
  nowMs: number = Date.now(),
): boolean {
  return evaluateZapQuoteInvalidation(quote, nowMs).status === "expired";
}

export interface ZapQuoteRequestParams {
  inputTokenContract: string;
  vaultTokenContract: string;
  amountInStroops: string;
  slippageTolerance: number;
}

/** Stable key for matching in-flight quote responses to the latest user input. */
export function buildZapQuoteRequestKey(params: ZapQuoteRequestParams): string {
  return [
    params.inputTokenContract,
    params.vaultTokenContract,
    params.amountInStroops,
    params.slippageTolerance.toFixed(4),
  ].join(":");
}

/** Recalculate min output from expected out and slippage tolerance (percent). */
export function recalculateMinOut(
  expectedOut: bigint,
  slippageTolerancePct: number,
  minAmountAfterSlippage: (amount: bigint, slippagePct: number) => bigint,
): bigint | null {
  if (expectedOut <= 0n) return null;
  return minAmountAfterSlippage(expectedOut, slippageTolerancePct);
}

export function quoteAgeSeconds(quotedAt: string, nowMs: number = Date.now()): number {
  return Math.floor((nowMs - new Date(quotedAt).getTime()) / 1000);
}

export type { ZapQuoteResponse };
