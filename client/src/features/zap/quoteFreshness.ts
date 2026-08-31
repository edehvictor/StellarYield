import type { ZapQuoteResponse } from "./types";

export const ZAP_QUOTE_TTL_MS = 60_000;

export interface ZapQuoteFreshnessInput {
  expiresAt?: string;
  quotedAt: string;
}

/** Returns true when a zap quote should be treated as stale. */
export function isZapQuoteExpired(
  quote: ZapQuoteFreshnessInput,
  nowMs: number = Date.now(),
): boolean {
  if (quote.expiresAt) {
    const expiresMs = new Date(quote.expiresAt).getTime();
    if (Number.isFinite(expiresMs)) {
      return nowMs > expiresMs;
    }
  }
  const quotedMs = new Date(quote.quotedAt).getTime();
  return nowMs - quotedMs > ZAP_QUOTE_TTL_MS;
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
