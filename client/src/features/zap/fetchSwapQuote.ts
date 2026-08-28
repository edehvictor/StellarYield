import type { ZapQuoteRequest, ZapQuoteResponse, ZapVerifyRequest, ZapVerifyResponse } from "./types";
import { apiUrl } from "../../lib/api";

/**
 * Ask the backend for the best known swap path and expected vault-token output.
 * Falls back to a deterministic ratio when the DEX router is not configured.
 * Includes slippage tolerance and returns quote metadata (age, source, min output).
 * Now also returns safety envelope fields: quoteId, expiresAt, ttlMs, and bound assumptions.
 */
export async function fetchSwapQuote(
  req: ZapQuoteRequest,
): Promise<ZapQuoteResponse> {
  const res = await fetch(apiUrl("/api/zap/quote"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Quote failed (${res.status})`);
  }

  return res.json() as Promise<ZapQuoteResponse>;
}

/**
 * Verify that a previously issued quote is still fresh, bound to the same
 * asset pair/route, and not invalidated by a freeze. The backend checks:
 * - quote expiry / TTL
 * - asset-pair binding
 * - route binding
 * - freeze invalidation (quote produced before freeze)
 */
export async function fetchVerifyQuote(
  req: ZapVerifyRequest,
): Promise<ZapVerifyResponse> {
  const res = await fetch(apiUrl("/api/zap/verify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Normalize error shape from sendError helper
    const reason =
      (body as { details?: string; message?: string; error?: string }).details ||
      (body as { message?: string }).message ||
      (body as { error?: string }).error ||
      `Quote verification failed (${res.status})`;
    const code = (body as { code?: string }).code;
    // Throw with code so callers can branch on FROZEN / EXPIRED etc.
    const err = new Error(reason) as Error & { code?: string; status?: number };
    err.code = code;
    err.status = res.status;
    throw err;
  }

  return body as ZapVerifyResponse;
}

/**
 * Returns true if the quote is considered expired (either via expiresAt or age).
 * Used for local pre-flight checks before hitting the verify endpoint.
 */
export function isQuoteExpiredLocal(quote: ZapQuoteResponse): boolean {
  if (quote.expiresAt) {
    return Date.now() > new Date(quote.expiresAt).getTime();
  }
  if (quote.ttlMs !== undefined && quote.quotedAt) {
    return Date.now() > new Date(quote.quotedAt).getTime() + quote.ttlMs;
  }
  // Fallback to quoteAgeMs-style staleness (60s)
  if (quote.quotedAt) {
    return Date.now() - new Date(quote.quotedAt).getTime() > 60_000;
  }
  return true;
}
