/**
 * Shared API Error Catalog
 *
 * Defines typed error codes for every common API failure category, maps each
 * code to a retry category, and documents the appropriate HTTP status code so
 * routes stay consistent.
 *
 * Usage in a route:
 *
 *   import { API_ERRORS } from "../types/apiErrorCatalog";
 *   import { catalogError } from "../utils/catalogErrorResponse";
 *
 *   return catalogError(res, API_ERRORS.VALIDATION_FAILED, "amount must be > 0");
 */

// ── Retry categories ──────────────────────────────────────────────────────

/**
 * How the client should react after receiving this error.
 *
 * - "retry"       — transient; the same request may succeed after a short wait
 * - "reconnect"   — connection-level issue; re-establish the transport first
 * - "refresh"     — client state is stale; re-fetch data before retrying
 * - "auth"        — credentials missing or invalid; prompt the user to re-auth
 * - "blocking"    — cannot recover without user or operator action (e.g. bad input, permissions)
 */
export type RetryCategory = "retry" | "reconnect" | "refresh" | "auth" | "blocking";

// ── Error code union ──────────────────────────────────────────────────────

export type ApiErrorCode =
  // Validation
  | "VALIDATION_FAILED"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_FORMAT"
  // Auth
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "TOKEN_EXPIRED"
  | "TOKEN_INVALID"
  // Timestamp / replay protection
  | "TIMESTAMP_MISSING"
  | "TIMESTAMP_EXPIRED"
  | "TIMESTAMP_FUTURE"
  | "TIMESTAMP_INVALID"
  // Rate limiting
  | "RATE_LIMITED"
  // Client errors
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  // Server / upstream errors
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_ERROR"
  | "DB_UNAVAILABLE"
  // Data freshness
  | "STALE_DATA"
  | "DATA_UNAVAILABLE";

// ── Error descriptor ──────────────────────────────────────────────────────

export interface ApiErrorDescriptor {
  /** Stable machine-readable code — never changes between releases. */
  code: ApiErrorCode;
  /** Default HTTP status code for this error type. */
  httpStatus: number;
  /** How clients should respond to this error category. */
  retryCategory: RetryCategory;
  /** Short human-readable summary used as a fallback message. */
  defaultMessage: string;
}

// ── Catalog ───────────────────────────────────────────────────────────────

export const API_ERRORS: Record<ApiErrorCode, ApiErrorDescriptor> = {
  // Validation
  VALIDATION_FAILED: {
    code: "VALIDATION_FAILED",
    httpStatus: 400,
    retryCategory: "blocking",
    defaultMessage: "One or more request fields failed validation.",
  },
  MISSING_REQUIRED_FIELD: {
    code: "MISSING_REQUIRED_FIELD",
    httpStatus: 400,
    retryCategory: "blocking",
    defaultMessage: "A required field is missing from the request.",
  },
  INVALID_FORMAT: {
    code: "INVALID_FORMAT",
    httpStatus: 400,
    retryCategory: "blocking",
    defaultMessage: "A field value is present but in an unexpected format.",
  },

  // Auth
  UNAUTHORIZED: {
    code: "UNAUTHORIZED",
    httpStatus: 401,
    retryCategory: "auth",
    defaultMessage: "Authentication is required to access this resource.",
  },
  FORBIDDEN: {
    code: "FORBIDDEN",
    httpStatus: 403,
    retryCategory: "blocking",
    defaultMessage: "You do not have permission to perform this action.",
  },
  TOKEN_EXPIRED: {
    code: "TOKEN_EXPIRED",
    httpStatus: 401,
    retryCategory: "auth",
    defaultMessage: "Your session token has expired. Please sign in again.",
  },
  TOKEN_INVALID: {
    code: "TOKEN_INVALID",
    httpStatus: 401,
    retryCategory: "auth",
    defaultMessage: "The supplied token is malformed or invalid.",
  },

  // Timestamp / replay protection
  TIMESTAMP_MISSING: {
    code: "TIMESTAMP_MISSING",
    httpStatus: 400,
    retryCategory: "blocking",
    defaultMessage: "The X-Signed-Timestamp header is required for this endpoint.",
  },
  TIMESTAMP_EXPIRED: {
    code: "TIMESTAMP_EXPIRED",
    httpStatus: 400,
    retryCategory: "retry",
    defaultMessage: "The signed timestamp is outside the allowed clock window.",
  },
  TIMESTAMP_FUTURE: {
    code: "TIMESTAMP_FUTURE",
    httpStatus: 400,
    retryCategory: "blocking",
    defaultMessage: "The signed timestamp is too far in the future.",
  },
  TIMESTAMP_INVALID: {
    code: "TIMESTAMP_INVALID",
    httpStatus: 400,
    retryCategory: "blocking",
    defaultMessage: "The signed timestamp value is not a valid ISO-8601 date or Unix epoch.",
  },

  // Rate limiting
  RATE_LIMITED: {
    code: "RATE_LIMITED",
    httpStatus: 429,
    retryCategory: "retry",
    defaultMessage: "Too many requests. Please wait before retrying.",
  },

  // Client errors
  NOT_FOUND: {
    code: "NOT_FOUND",
    httpStatus: 404,
    retryCategory: "blocking",
    defaultMessage: "The requested resource was not found.",
  },
  CONFLICT: {
    code: "CONFLICT",
    httpStatus: 409,
    retryCategory: "refresh",
    defaultMessage: "A conflicting resource state prevented this operation.",
  },
  PAYLOAD_TOO_LARGE: {
    code: "PAYLOAD_TOO_LARGE",
    httpStatus: 413,
    retryCategory: "blocking",
    defaultMessage: "The request payload exceeds the maximum allowed size.",
  },

  // Server / upstream errors
  INTERNAL_ERROR: {
    code: "INTERNAL_ERROR",
    httpStatus: 500,
    retryCategory: "retry",
    defaultMessage: "An unexpected server error occurred.",
  },
  SERVICE_UNAVAILABLE: {
    code: "SERVICE_UNAVAILABLE",
    httpStatus: 503,
    retryCategory: "reconnect",
    defaultMessage: "The service is temporarily unavailable. Please try again shortly.",
  },
  UPSTREAM_TIMEOUT: {
    code: "UPSTREAM_TIMEOUT",
    httpStatus: 504,
    retryCategory: "retry",
    defaultMessage: "An upstream service did not respond in time.",
  },
  UPSTREAM_ERROR: {
    code: "UPSTREAM_ERROR",
    httpStatus: 502,
    retryCategory: "retry",
    defaultMessage: "An upstream service returned an unexpected error.",
  },
  DB_UNAVAILABLE: {
    code: "DB_UNAVAILABLE",
    httpStatus: 503,
    retryCategory: "reconnect",
    defaultMessage: "The database is temporarily unavailable.",
  },

  // Data freshness
  STALE_DATA: {
    code: "STALE_DATA",
    httpStatus: 200,
    retryCategory: "refresh",
    defaultMessage: "The returned data may be stale. A refresh is recommended.",
  },
  DATA_UNAVAILABLE: {
    code: "DATA_UNAVAILABLE",
    httpStatus: 503,
    retryCategory: "reconnect",
    defaultMessage: "Required data is currently unavailable.",
  },
};

// ── Lookup helpers ────────────────────────────────────────────────────────

/** Returns the descriptor for a code, or undefined if unrecognised. */
export function lookupError(code: string): ApiErrorDescriptor | undefined {
  return API_ERRORS[code as ApiErrorCode];
}

/** True when `code` is a known, stable catalog entry. */
export function isKnownApiError(code: string): code is ApiErrorCode {
  return Object.prototype.hasOwnProperty.call(API_ERRORS, code);
}

/** True when the retry category means a simple client retry may succeed. */
export function isRetryable(retryCategory: RetryCategory): boolean {
  return retryCategory === "retry" || retryCategory === "reconnect";
}
