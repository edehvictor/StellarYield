/**
 * Client-side error handling and classification for portfolio valuations (#1660).
 *
 * Ensures failures (e.g. price oracle unreachable, network drop, timeout) return
 * stable, user-presentable error messages instead of raw provider output or
 * exceptions, and supports state-preserving recovery flows.
 */

export type PortfolioValuationErrorCode =
  | "VALUATION_REFRESH_FAILED"
  | "PRICE_FEED_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "RATE_LIMITED";

export interface PortfolioValuationFailure {
  /** Stable machine-readable code. */
  code: PortfolioValuationErrorCode;
  /** Safe, human-readable copy. */
  message: string;
  /** Whether retrying may succeed. */
  retryable: boolean;
  /** When the failure occurred. */
  timestamp: string;
}

export class PortfolioValuationError extends Error {
  readonly code: PortfolioValuationErrorCode;
  readonly retryable: boolean;
  readonly timestamp: string;

  constructor(failure: PortfolioValuationFailure) {
    super(failure.message);
    this.name = "PortfolioValuationError";
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.timestamp = failure.timestamp;
  }
}

const KNOWN_ERROR_MESSAGES: Record<PortfolioValuationErrorCode, string> = {
  VALUATION_REFRESH_FAILED:
    "Unable to refresh portfolio valuations. Displaying last known positions.",
  PRICE_FEED_UNAVAILABLE:
    "Price feeds are currently offline or unreachable. Displaying cached valuations.",
  NETWORK_ERROR:
    "Network connectivity lost. Retaining active portfolio view.",
  RATE_LIMITED:
    "Valuation provider rate limit reached. Please wait a moment before refreshing.",
};

/**
 * Normalizes any caught error into a typed, stable failure description.
 * Raw exceptions, provider strings, and stack traces are suppressed.
 */
export function describeValuationFailure(error: unknown): PortfolioValuationFailure {
  const timestamp = new Date().toISOString();

  if (error instanceof PortfolioValuationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      timestamp: error.timestamp,
    };
  }

  const rawMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  let code: PortfolioValuationErrorCode = "VALUATION_REFRESH_FAILED";
  const retryable = true;

  if (rawMessage.includes("rate limit") || rawMessage.includes("429")) {
    code = "RATE_LIMITED";
  } else if (rawMessage.includes("network") || rawMessage.includes("fetch failed") || rawMessage.includes("failed to fetch")) {
    code = "NETWORK_ERROR";
  } else if (rawMessage.includes("oracle") || rawMessage.includes("price") || rawMessage.includes("quote")) {
    code = "PRICE_FEED_UNAVAILABLE";
  }

  return {
    code,
    message: KNOWN_ERROR_MESSAGES[code],
    retryable,
    timestamp,
  };
}
