/**
 * Client-Side API Error Catalog
 *
 * Mirrors the server's catalog so the client can interpret a `code` field in
 * any API error response and decide:
 *   - whether to retry automatically
 *   - which recovery action to surface in the UI
 *
 * Keep this in sync with server/src/types/apiErrorCatalog.ts — the `code`
 * strings are the shared contract between client and server.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type RetryCategory = "retry" | "reconnect" | "refresh" | "auth" | "blocking";

/**
 * The UI recovery action the client should present to the user.
 *
 * - "retry"         — show a "Try again" button
 * - "reconnect"     — show a "Reconnect" or "Reload" button
 * - "refresh_data"  — silently re-fetch data, or show "Refresh" button
 * - "sign_in"       — redirect/prompt to sign in again
 * - "none"          — surface the error message; no actionable recovery
 */
export type ClientRecoveryAction = "retry" | "reconnect" | "refresh_data" | "sign_in" | "none";

export interface ClientErrorEntry {
  /** Stable machine-readable code — matches the server catalog. */
  code: string;
  retryCategory: RetryCategory;
  /** Short user-facing message shown in UI banners. */
  userMessage: string;
  recoveryAction: ClientRecoveryAction;
  /** Label for the recovery action button shown to the user. */
  recoveryLabel: string | null;
}

// ── Catalog ───────────────────────────────────────────────────────────────

export const CLIENT_ERROR_CATALOG: Record<string, ClientErrorEntry> = {
  VALIDATION_FAILED: {
    code: "VALIDATION_FAILED",
    retryCategory: "blocking",
    userMessage: "Some fields are invalid. Please review and try again.",
    recoveryAction: "none",
    recoveryLabel: null,
  },
  MISSING_REQUIRED_FIELD: {
    code: "MISSING_REQUIRED_FIELD",
    retryCategory: "blocking",
    userMessage: "A required field is missing.",
    recoveryAction: "none",
    recoveryLabel: null,
  },
  INVALID_FORMAT: {
    code: "INVALID_FORMAT",
    retryCategory: "blocking",
    userMessage: "A field value is in an unexpected format.",
    recoveryAction: "none",
    recoveryLabel: null,
  },

  UNAUTHORIZED: {
    code: "UNAUTHORIZED",
    retryCategory: "auth",
    userMessage: "You need to sign in to continue.",
    recoveryAction: "sign_in",
    recoveryLabel: "Sign in",
  },
  FORBIDDEN: {
    code: "FORBIDDEN",
    retryCategory: "blocking",
    userMessage: "You don't have permission to perform this action.",
    recoveryAction: "none",
    recoveryLabel: null,
  },
  TOKEN_EXPIRED: {
    code: "TOKEN_EXPIRED",
    retryCategory: "auth",
    userMessage: "Your session has expired. Please sign in again.",
    recoveryAction: "sign_in",
    recoveryLabel: "Sign in",
  },
  TOKEN_INVALID: {
    code: "TOKEN_INVALID",
    retryCategory: "auth",
    userMessage: "Your session token is invalid. Please sign in again.",
    recoveryAction: "sign_in",
    recoveryLabel: "Sign in",
  },

  TIMESTAMP_MISSING: {
    code: "TIMESTAMP_MISSING",
    retryCategory: "blocking",
    userMessage: "A required security header is missing. Please refresh and retry.",
    recoveryAction: "refresh_data",
    recoveryLabel: "Refresh",
  },
  TIMESTAMP_EXPIRED: {
    code: "TIMESTAMP_EXPIRED",
    retryCategory: "retry",
    userMessage: "The request timestamp expired. Please try again.",
    recoveryAction: "retry",
    recoveryLabel: "Try again",
  },
  TIMESTAMP_FUTURE: {
    code: "TIMESTAMP_FUTURE",
    retryCategory: "blocking",
    userMessage: "Your device clock appears to be set in the future. Please correct it and retry.",
    recoveryAction: "none",
    recoveryLabel: null,
  },
  TIMESTAMP_INVALID: {
    code: "TIMESTAMP_INVALID",
    retryCategory: "blocking",
    userMessage: "The request timestamp is malformed.",
    recoveryAction: "none",
    recoveryLabel: null,
  },

  RATE_LIMITED: {
    code: "RATE_LIMITED",
    retryCategory: "retry",
    userMessage: "Too many requests. Please wait a moment and try again.",
    recoveryAction: "retry",
    recoveryLabel: "Try again",
  },

  NOT_FOUND: {
    code: "NOT_FOUND",
    retryCategory: "blocking",
    userMessage: "The requested resource was not found.",
    recoveryAction: "none",
    recoveryLabel: null,
  },
  CONFLICT: {
    code: "CONFLICT",
    retryCategory: "refresh",
    userMessage: "There was a conflict with the current state. Refreshing may resolve it.",
    recoveryAction: "refresh_data",
    recoveryLabel: "Refresh",
  },
  PAYLOAD_TOO_LARGE: {
    code: "PAYLOAD_TOO_LARGE",
    retryCategory: "blocking",
    userMessage: "The request is too large.",
    recoveryAction: "none",
    recoveryLabel: null,
  },

  INTERNAL_ERROR: {
    code: "INTERNAL_ERROR",
    retryCategory: "retry",
    userMessage: "Something went wrong on our end. Please try again.",
    recoveryAction: "retry",
    recoveryLabel: "Try again",
  },
  SERVICE_UNAVAILABLE: {
    code: "SERVICE_UNAVAILABLE",
    retryCategory: "reconnect",
    userMessage: "The service is temporarily unavailable. Please try reconnecting.",
    recoveryAction: "reconnect",
    recoveryLabel: "Reconnect",
  },
  UPSTREAM_TIMEOUT: {
    code: "UPSTREAM_TIMEOUT",
    retryCategory: "retry",
    userMessage: "A dependent service timed out. Please try again.",
    recoveryAction: "retry",
    recoveryLabel: "Try again",
  },
  UPSTREAM_ERROR: {
    code: "UPSTREAM_ERROR",
    retryCategory: "retry",
    userMessage: "A dependent service returned an error. Please try again.",
    recoveryAction: "retry",
    recoveryLabel: "Try again",
  },
  DB_UNAVAILABLE: {
    code: "DB_UNAVAILABLE",
    retryCategory: "reconnect",
    userMessage: "The database is temporarily unavailable. Please try again in a moment.",
    recoveryAction: "reconnect",
    recoveryLabel: "Reconnect",
  },

  STALE_DATA: {
    code: "STALE_DATA",
    retryCategory: "refresh",
    userMessage: "The data may be outdated. A refresh is recommended.",
    recoveryAction: "refresh_data",
    recoveryLabel: "Refresh",
  },
  DATA_UNAVAILABLE: {
    code: "DATA_UNAVAILABLE",
    retryCategory: "reconnect",
    userMessage: "Required data is currently unavailable.",
    recoveryAction: "reconnect",
    recoveryLabel: "Reconnect",
  },
};

// ── Unknown fallback ──────────────────────────────────────────────────────

const UNKNOWN_ERROR_ENTRY: ClientErrorEntry = {
  code: "UNKNOWN",
  retryCategory: "retry",
  userMessage: "An unexpected error occurred. Please try again.",
  recoveryAction: "retry",
  recoveryLabel: "Try again",
};

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve an API error code to its client catalog entry.
 * Returns a safe fallback for unknown codes so callers never need to null-check.
 */
export function resolveApiError(code: string): ClientErrorEntry {
  return CLIENT_ERROR_CATALOG[code] ?? { ...UNKNOWN_ERROR_ENTRY, code };
}

/**
 * True when the error category means a simple retry may succeed without
 * any user action.
 */
export function isAutoRetryable(entry: ClientErrorEntry): boolean {
  return entry.retryCategory === "retry";
}

/**
 * True when the client should prompt the user to re-authenticate.
 */
export function requiresReauth(entry: ClientErrorEntry): boolean {
  return entry.retryCategory === "auth";
}

/**
 * Parse a raw API error response body (from fetch) and return the catalog
 * entry. Handles both `{ code }` and legacy `{ error }` shapes.
 */
export function parseApiErrorResponse(body: unknown): ClientErrorEntry {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const code = typeof b.code === "string" ? b.code : typeof b.error === "string" ? b.error : null;
    if (code) return resolveApiError(code);
  }
  return UNKNOWN_ERROR_ENTRY;
}
