/**
 * Withdraw quote freshness (#1308).
 *
 * Shared staleness contract for the WithdrawPanel transaction modal.
 * Mirrors `features/zap/quoteFreshness.ts`: a quote is stale when
 * `now > expiresAt`, falling back to `quotedAt + TTL` when the backend
 * omits `expiresAt` (e.g. older cached previews).
 */

/** TTL applied by `POST /api/vaults/:vaultId/withdrawal-preview`. */
export const WITHDRAW_QUOTE_TTL_MS = 60_000;

export interface WithdrawQuoteFreshnessInput {
  quotedAt: string;
  expiresAt?: string;
}

/** Returns true when a withdrawal quote should be treated as stale. */
export function isWithdrawQuoteStale(
  quote: WithdrawQuoteFreshnessInput | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!quote || !quote.quotedAt) return false;
  if (quote.expiresAt) {
    const expiresMs = new Date(quote.expiresAt).getTime();
    if (Number.isFinite(expiresMs)) return nowMs > expiresMs;
  }
  const quotedMs = new Date(quote.quotedAt).getTime();
  if (!Number.isFinite(quotedMs)) return false;
  return nowMs - quotedMs > WITHDRAW_QUOTE_TTL_MS;
}

/** Whole seconds since the quote was issued (for the age badge). */
export function withdrawQuoteAgeSeconds(
  quotedAt: string,
  nowMs: number = Date.now(),
): number {
  const quotedMs = new Date(quotedAt).getTime();
  if (!Number.isFinite(quotedMs)) return 0;
  return Math.max(0, Math.floor((nowMs - quotedMs) / 1000));
}
