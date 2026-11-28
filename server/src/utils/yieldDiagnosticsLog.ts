/**
 * Server-side logging for yield data failures (#1877).
 *
 * The full error never leaves the server, but server logs are shipped to
 * third-party log stores too, so the logged message is redacted: URL query
 * strings and credentials, bearer tokens, Stellar secret seeds, e-mail
 * addresses and long opaque tokens are masked, and the message is truncated.
 * Stack traces are not logged.
 */
import type { YieldDiagnostic } from "../../../shared/types/yieldDiagnostics";

const MAX_LOGGED_MESSAGE = 300;

const REDACTIONS: Array<[RegExp, string]> = [
  // user:password@ in URLs
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@"],
  // URL query strings (often carry api keys)
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[redacted]"],
  // Authorization-style tokens
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  // key=value / key: value secrets
  [/\b(api[_-]?key|apikey|secret|password|passwd|token|access[_-]?key)(\s*[=:]\s*)[^\s,;&]+/gi, "$1$2[redacted]"],
  // Stellar secret seeds
  [/\bS[A-Z2-7]{55}\b/g, "[redacted-seed]"],
  // e-mail addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
  // long opaque tokens (hex/base64-ish, 32+ chars)
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted-token]"],
];

/** Redact sensitive substrings from an error message for logging. */
export function redactForLog(value: unknown): string {
  let text: string;
  if (value instanceof Error) {
    text = value.message;
  } else if (typeof value === "string") {
    text = value;
  } else {
    text = "";
  }
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text.length > MAX_LOGGED_MESSAGE ? `${text.slice(0, MAX_LOGGED_MESSAGE)}…` : text;
}

export interface YieldFailureLogEntry {
  event: "yield_request_failed";
  code: YieldDiagnostic["code"];
  stage: YieldDiagnostic["stage"];
  requestId?: string;
  errorName: string;
  errorMessage: string;
}

/** Build the structured, redacted log entry for a failure. */
export function buildYieldFailureLogEntry(
  diagnostic: YieldDiagnostic,
  cause: unknown,
): YieldFailureLogEntry {
  const entry: YieldFailureLogEntry = {
    event: "yield_request_failed",
    code: diagnostic.code,
    stage: diagnostic.stage,
    errorName: cause instanceof Error ? cause.name : typeof cause,
    errorMessage: redactForLog(cause),
  };
  if (diagnostic.requestId) entry.requestId = diagnostic.requestId;
  return entry;
}

export function logYieldFailure(diagnostic: YieldDiagnostic, cause: unknown): void {
  console.error("Failed to serve /api/yields.", buildYieldFailureLogEntry(diagnostic, cause));
}
