import type { ZapQuoteRequest, ZapQuoteResponse, ZapVerifyRequest, ZapVerifyResponse } from "./types";
import { apiUrl } from "../../lib/api";

/**
 * Ask the backend for the best known swap path and expected vault-token output.
 * Falls back to a deterministic ratio when the DEX router is not configured.
 * Includes slippage tolerance and returns quote metadata (age, source, min output).
 * Now also returns safety envelope fields: quoteId, expiresAt, ttlMs, and bound assumptions.
 * Merged with upstream which adds issuedAt/expiresAt/routeHash/version.
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
 * Merged: keeps our ZapVerifyRequest variant for fine-grained verify.
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
 * Upstream verify helper — posts the full quote and returns boolean success.
 * Kept for backward compat with upstream callers.
 */
export async function verifySwapQuote(quote: ZapQuoteResponse): Promise<boolean> {
  const res = await fetch(apiUrl("/api/zap/verify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(quote),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || `Quote verification failed (${res.status})`);
  }
  const data = await res.json();
  // Upstream returns { success: true }, our branch returns { valid: true }
  if (typeof data.success === "boolean") return data.success === true;
  if (typeof data.valid === "boolean") return data.valid === true;
  return true;
}

/**
 * Returns true if the quote is considered expired (either via expiresAt or age).
 * Used for local pre-flight checks before hitting the verify endpoint.
 * Supports both our ttlMs and upstream expiresAt/issuedAt.
 */
export function isQuoteExpiredLocal(quote: ZapQuoteResponse): boolean {
  if (quote.expiresAt) {
    return Date.now() > new Date(quote.expiresAt).getTime();
  }
  if (quote.ttlMs !== undefined && quote.quotedAt) {
    return Date.now() > new Date(quote.quotedAt).getTime() + quote.ttlMs;
  }
  if (quote.issuedAt) {
    // Upstream uses issuedAt + expiresAt; if expiresAt is missing above, use issuedAt fallback
    // Assume 60s TTL if no expiresAt
    return Date.now() > new Date(quote.issuedAt).getTime() + 60_000;
  }
  // Fallback to quoteAgeMs-style staleness (60s)
  if (quote.quotedAt) {
    return Date.now() - new Date(quote.quotedAt).getTime() > 60_000;
  }
  return true;
}
