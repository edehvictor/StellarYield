/**
 * Typed error model for Google Sheets / OAuth failure modes.
 *
 * Design goals:
 *  - Every failure mode the user can encounter has a stable, machine-readable
 *    `code` so the UI can branch on it without string-parsing.
 *  - Each code carries a `message` (what went wrong) and a `remediation`
 *    (what the user should do next), so banners can be self-contained.
 *  - `classifyGoogleError()` is the single entry-point for turning any
 *    thrown value (API error body, fetch rejection, etc.) into a
 *    `GoogleAuthError` — nothing else in the codebase needs to branch on
 *    `instanceof TypeError` or inspect raw response bodies.
 */

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Stable machine-readable codes for every Google Sheets / OAuth failure mode.
 *
 * `OAUTH_DENIED`       — user explicitly cancelled or denied the OAuth prompt.
 * `TOKEN_EXPIRED`      — access token expired; a silent token refresh is possible.
 * `REAUTH_REQUIRED`    — refresh token revoked / invalid; user must reconnect.
 * `INSUFFICIENT_SCOPE` — granted scopes don't include Sheets; user must reconnect
 *                         and re-grant the Sheets permission.
 * `ACCESS_DENIED`      — spreadsheet not shared with the connected account,
 *                         or a generic 403 from the Sheets API.
 * `NETWORK_ERROR`      — fetch() rejected (offline, DNS failure, timeout).
 */
export type GoogleAuthErrorCode =
  | "OAUTH_DENIED"
  | "TOKEN_EXPIRED"
  | "REAUTH_REQUIRED"
  | "INSUFFICIENT_SCOPE"
  | "ACCESS_DENIED"
  | "NETWORK_ERROR";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class GoogleAuthError extends Error {
  readonly code: GoogleAuthErrorCode;

  constructor(message: string, code: GoogleAuthErrorCode) {
    super(message);
    this.name = "GoogleAuthError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REQUIRED_SHEETS_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets";

// ---------------------------------------------------------------------------
// User-facing messages
// ---------------------------------------------------------------------------

/**
 * Human-readable description of each failure mode.
 * Keep these factual and brief — the UI pairs them with a `remediation` CTA.
 */
export const GOOGLE_AUTH_MESSAGES: Record<GoogleAuthErrorCode, string> = {
  OAUTH_DENIED:
    "Google sign-in was cancelled or denied.",
  TOKEN_EXPIRED:
    "Your Google access token has expired.",
  REAUTH_REQUIRED:
    "Google authorization expired or was revoked.",
  INSUFFICIENT_SCOPE:
    "Your Google account is missing the required Sheets permission.",
  ACCESS_DENIED:
    "Google Sheets access was denied. The spreadsheet may not be shared with your account.",
  NETWORK_ERROR:
    "Could not reach Google — check your internet connection and try again.",
};

/**
 * Short, actionable remediation instructions for each failure mode.
 * These are shown alongside the `GOOGLE_AUTH_MESSAGES` entry in the panel.
 */
export const GOOGLE_AUTH_REMEDIATION: Record<GoogleAuthErrorCode, string> = {
  OAUTH_DENIED:
    "Click \"Connect Google Account\" to try again. If you changed your mind, no data has been stored.",
  TOKEN_EXPIRED:
    "Your session will refresh automatically. If it doesn't, click \"Reconnect\" to sign in again.",
  REAUTH_REQUIRED:
    "Click \"Reconnect\" to sign in with Google again. This happens when permissions are revoked or tokens expire.",
  INSUFFICIENT_SCOPE:
    "Click \"Reconnect\" and make sure you tick the \"Google Sheets\" checkbox when Google asks for permissions.",
  ACCESS_DENIED:
    "Open the spreadsheet in Google Sheets and share it with your connected Google account, then try again.",
  NETWORK_ERROR:
    "Check your internet connection and try again. If the problem persists, the Google API may be temporarily unavailable.",
};

/**
 * Whether a given error code can be resolved by reconnecting (i.e. restarting
 * the OAuth flow), as opposed to a user action outside the app.
 */
export const GOOGLE_AUTH_REQUIRES_RECONNECT: Record<GoogleAuthErrorCode, boolean> = {
  OAUTH_DENIED: true,
  TOKEN_EXPIRED: true,
  REAUTH_REQUIRED: true,
  INSUFFICIENT_SCOPE: true,
  ACCESS_DENIED: false,
  NETWORK_ERROR: false,
};

// ---------------------------------------------------------------------------
// Error classifier
// ---------------------------------------------------------------------------

/**
 * Classify any thrown value into a `GoogleAuthError`.
 *
 * Call this in `catch` blocks instead of branching on `instanceof`:
 *
 * ```ts
 * try { ... }
 * catch (err) { throw classifyGoogleError(err); }
 * ```
 *
 * Mapping rules:
 *  - Already a `GoogleAuthError` → returned unchanged.
 *  - `TypeError` with a network-flavour message (fetch rejection) → `NETWORK_ERROR`.
 *  - Plain `Error` with a message string → inspected for known OAuth keywords.
 *  - Anything else → `ACCESS_DENIED` with the stringified value.
 */
export function classifyGoogleError(err: unknown): GoogleAuthError {
  if (err instanceof GoogleAuthError) return err;

  if (err instanceof TypeError) {
    // fetch() rejects with TypeError for network failures (offline, DNS, CORS)
    return new GoogleAuthError(
      GOOGLE_AUTH_MESSAGES.NETWORK_ERROR,
      "NETWORK_ERROR",
    );
  }

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();

    if (msg.includes("network") || msg.includes("failed to fetch") || msg.includes("econnrefused")) {
      return new GoogleAuthError(GOOGLE_AUTH_MESSAGES.NETWORK_ERROR, "NETWORK_ERROR");
    }
    if (msg.includes("access_denied") || msg.includes("denied")) {
      return new GoogleAuthError(GOOGLE_AUTH_MESSAGES.OAUTH_DENIED, "OAUTH_DENIED");
    }
    if (msg.includes("invalid_grant") || msg.includes("revoked") || msg.includes("reauth")) {
      return new GoogleAuthError(GOOGLE_AUTH_MESSAGES.REAUTH_REQUIRED, "REAUTH_REQUIRED");
    }
    if (msg.includes("expired")) {
      return new GoogleAuthError(GOOGLE_AUTH_MESSAGES.TOKEN_EXPIRED, "TOKEN_EXPIRED");
    }
    if (msg.includes("scope") || msg.includes("insufficient")) {
      return new GoogleAuthError(GOOGLE_AUTH_MESSAGES.INSUFFICIENT_SCOPE, "INSUFFICIENT_SCOPE");
    }

    return new GoogleAuthError(err.message, "ACCESS_DENIED");
  }

  return new GoogleAuthError(
    typeof err === "string" ? err : "An unexpected error occurred",
    "ACCESS_DENIED",
  );
}

/**
 * Parse the `error` query-string parameter that Google appends to the OAuth
 * redirect URL when the user denies the consent screen or an error occurs:
 *
 *   https://your-app.com/callback?error=access_denied
 *
 * Returns `null` when no error parameter is present (happy path).
 */
export function parseOAuthCallbackError(
  searchParams: URLSearchParams,
): GoogleAuthError | null {
  const error = searchParams.get("error");
  if (!error) return null;

  switch (error) {
    case "access_denied":
      return new GoogleAuthError(GOOGLE_AUTH_MESSAGES.OAUTH_DENIED, "OAUTH_DENIED");
    case "invalid_scope":
      return new GoogleAuthError(GOOGLE_AUTH_MESSAGES.INSUFFICIENT_SCOPE, "INSUFFICIENT_SCOPE");
    default:
      return new GoogleAuthError(
        `Google OAuth error: ${error}`,
        "ACCESS_DENIED",
      );
  }
}
