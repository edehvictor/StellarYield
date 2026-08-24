import type { ZapQuoteRequest, ZapQuoteResponse } from "./types";
import { apiUrl } from "../../lib/api";

/** Subset of the server's `ErrorResponse` payload relevant to quote previews. */
interface ZapQuoteErrorBody {
  error?: unknown;
  message?: unknown;
  requestId?: unknown;
  recoverable?: unknown;
}

/**
 * Typed failure from the zap quote preview API. Preserves the server's
 * ErrorResponse fields so the UI can explain the failure and decide whether
 * to offer recovery actions (explorer / support / retry).
 */
export class ZapQuoteError extends Error {
  /** Server error code (e.g. "QUOTE_FAILED", "MISSING_FIELDS"). */
  readonly code: string;
  /** HTTP status of the failed response (0 for network-level failures). */
  readonly status: number;
  /** Server request id for log correlation when provided. */
  readonly requestId?: string;
  /** Whether recovery actions should be offered for this failure. */
  readonly recoverable: boolean;

  constructor(
    message: string,
    options: {
      code: string;
      status: number;
      requestId?: string;
      recoverable?: boolean;
    },
  ) {
    super(message);
    this.name = "ZapQuoteError";
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.recoverable = options.recoverable ?? false;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Builds a typed error from a failed quote response without throwing. */
async function toZapQuoteError(res: Response): Promise<ZapQuoteError> {
  let body: ZapQuoteErrorBody = {};
  let rawText = "";
  try {
    body = (await res.json()) as ZapQuoteErrorBody;
  } catch {
    try {
      rawText = await res.text();
    } catch {
      rawText = "";
    }
    try {
      body = JSON.parse(rawText) as ZapQuoteErrorBody;
    } catch {
      body = {};
    }
  }
  const fallback = `Quote failed (${res.status})`;
  const message = asString(body.message) ?? asString(body.error) ?? (rawText || fallback);
  return new ZapQuoteError(message, {
    code: asString(body.error) ?? "QUOTE_FAILED",
    status: res.status,
    requestId: asString(body.requestId),
    recoverable: body.recoverable === true,
  });
}

/**
 * Ask the backend for the best known swap path and expected vault-token output.
 * Falls back to a deterministic ratio when the DEX router is not configured.
 * Includes slippage tolerance and returns quote metadata (age, source, min output).
 * Throws a typed `ZapQuoteError` when the preview fails so recovery links
 * can be rendered by the UI.
 */
export async function fetchSwapQuote(
  req: ZapQuoteRequest,
): Promise<ZapQuoteResponse> {
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/zap/quote"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
  } catch (e) {
    throw new ZapQuoteError(e instanceof Error ? e.message : "Network request failed", {
      code: "NETWORK_ERROR",
      status: 0,
      recoverable: true,
    });
  }

  if (!res.ok) {
    throw await toZapQuoteError(res);
  }

  return res.json() as Promise<ZapQuoteResponse>;
}
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
  return data.success === true;
}
