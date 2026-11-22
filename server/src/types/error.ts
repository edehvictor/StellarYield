export interface ErrorResponse {
  error: string;
  message: string;
  requestId?: string;
  details?: unknown;
  /** Whether the client may offer recovery actions (explorer/support/retry). */
  recoverable?: boolean;
  /** Privacy-safe stage diagnostics (transaction review flow, #1893). */
  diagnostics?: unknown[];
}