import type { ZapQuoteRequest, ZapQuoteResponse } from "./types";

const defaultBase = (): string => {
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL as string;
  }
  return "http://localhost:3001";
};

/**
 * Ask the backend for the best known swap path and expected vault-token output.
 * Falls back to a deterministic ratio when the DEX router is not configured.
 */
export async function fetchSwapQuote(req: ZapQuoteRequest): Promise<ZapQuoteResponse> {
  const base = defaultBase().replace(/\/$/, "");
  const res = await fetch(`${base}/api/zap/quote`, {
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
