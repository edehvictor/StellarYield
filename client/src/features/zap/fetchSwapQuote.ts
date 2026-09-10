import type { ZapQuoteRequest, ZapQuoteResponse } from "./types";
import { apiUrl } from "../../lib/api";

export interface FetchSwapQuoteOptions {
  signal?: AbortSignal;
}

/** Typed cancellation for quote/verify fetches aborted by the caller. */
export class QuoteRequestCancelledError extends Error {
  readonly cancelled = true as const;

  constructor(message = "Quote request was cancelled") {
    super(message);
    this.name = "QuoteRequestCancelledError";
  }
}

export function isQuoteCancellation(error: unknown): boolean {
  return (
    error instanceof QuoteRequestCancelledError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { cancelled?: boolean }).cancelled === true)
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new QuoteRequestCancelledError();
  }
}

/**
 * Ask the backend for the best known swap path and expected vault-token output.
 * Falls back to a deterministic ratio when the DEX router is not configured.
 * Includes slippage tolerance and returns quote metadata (age, source, min output).
 * Pass `signal` to cancel in-flight quotes after route changes or rapid edits.
 */
export async function fetchSwapQuote(
  req: ZapQuoteRequest,
  options?: FetchSwapQuoteOptions,
): Promise<ZapQuoteResponse> {
  throwIfAborted(options?.signal);

  let res: Response;
  try {
    res = await fetch(apiUrl("/api/zap/quote"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: options?.signal,
    });
  } catch (err) {
    if (options?.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new QuoteRequestCancelledError();
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Quote failed (${res.status})`);
  }

  return res.json() as Promise<ZapQuoteResponse>;
}

export async function verifySwapQuote(
  quote: ZapQuoteResponse,
  options?: FetchSwapQuoteOptions,
): Promise<boolean> {
  throwIfAborted(options?.signal);

  let res: Response;
  try {
    res = await fetch(apiUrl("/api/zap/verify"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quote),
      signal: options?.signal,
    });
  } catch (err) {
    if (options?.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new QuoteRequestCancelledError();
    }
    throw err;
  }

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || `Quote verification failed (${res.status})`);
  }
  const data = await res.json();
  return data.success === true;
}
