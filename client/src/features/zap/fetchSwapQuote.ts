import type { ZapQuoteRequest, ZapQuoteResponse } from "./types";
import { apiUrl } from "../../lib/api";

/**
 * Ask the backend for the best known swap path and expected vault-token output.
 * Falls back to a deterministic ratio when the DEX router is not configured.
 */
export async function fetchSwapQuote(req: ZapQuoteRequest): Promise<ZapQuoteResponse> {
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
