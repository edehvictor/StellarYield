export type GoogleAuthErrorCode =
  | "REAUTH_REQUIRED"
  | "INSUFFICIENT_SCOPE"
  | "TOKEN_EXPIRED"
  | "ACCESS_DENIED";

export class GoogleAuthError extends Error {
  readonly code: GoogleAuthErrorCode;

  constructor(message: string, code: GoogleAuthErrorCode) {
    super(message);
    this.name = "GoogleAuthError";
    this.code = code;
  }
}

export const REQUIRED_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export const GOOGLE_AUTH_MESSAGES: Record<GoogleAuthErrorCode, string> = {
  REAUTH_REQUIRED:
    "Google authorization expired or was revoked. Reconnect your account to resume sync.",
  INSUFFICIENT_SCOPE:
    "Your Google account is missing the required Sheets permission. Reconnect to grant spreadsheet access.",
  TOKEN_EXPIRED: "Access token expired. Reconnecting…",
  ACCESS_DENIED: "Google Sheets access was denied. Please try again.",
};
