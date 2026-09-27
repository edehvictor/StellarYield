/**
 * Structured export failure codes (#1122).
 *
 * Every portfolio and treasury export failure is expressed as a stable,
 * machine-readable code paired with a coarse category so callers (especially
 * the frontend) can branch on validation vs. timeout vs. service-failure
 * without parsing human-readable messages or depending on HTTP status alone.
 *
 * Categories:
 *  - "validation"      — the request/input is wrong; retrying unchanged will fail again
 *  - "timeout"         — the export exceeded its deadline; a later retry may succeed
 *  - "service_failure" — an internal or upstream dependency failed; retry later
 */

// ── Categories ────────────────────────────────────────────────────────────

export type ExportFailureCategory = "validation" | "timeout" | "service_failure";

// ── Codes ─────────────────────────────────────────────────────────────────

export type ExportFailureCode =
  // Validation
  | "EXPORT_VALIDATION_FAILED"
  | "EXPORT_NO_DATA"
  | "EXPORT_SIZE_LIMIT_EXCEEDED"
  | "NO_TRANSACTIONS"
  | "PREVIEW_WARNINGS_PRESENT"
  | "IDEMPOTENCY_KEY_MISMATCH"
  // Timeout
  | "EXPORT_TIMEOUT"
  // Service failures
  | "EXPORT_SERVICE_UNAVAILABLE"
  | "EXPORT_SERVICE_FAILURE"
  | "EXPORT_FAILED"
  | "EXPORT_PREVIEW_FAILED"
  | "DB_UNAVAILABLE";

// ── Descriptor ────────────────────────────────────────────────────────────

export interface ExportFailureDescriptor {
  /** Stable machine-readable code — never changes between releases. */
  code: ExportFailureCode;
  /** Coarse category the UI can branch on. */
  category: ExportFailureCategory;
  /** Default HTTP status for this failure. */
  httpStatus: number;
  /** Whether retrying the same request may succeed later. */
  retryable: boolean;
  /** Human-readable fallback message. */
  defaultMessage: string;
  /** Suggested recovery actions for operators. */
  recoveryNote?: string;
}

// ── Catalog ───────────────────────────────────────────────────────────────

export const EXPORT_FAILURES: Record<ExportFailureCode, ExportFailureDescriptor> = {
  // Validation
  EXPORT_VALIDATION_FAILED: {
    code: "EXPORT_VALIDATION_FAILED",
    category: "validation",
    httpStatus: 400,
    retryable: false,
    defaultMessage: "The export request failed validation.",
    recoveryNote: "Verify that the requested filters are valid and supported.",
  },
  EXPORT_NO_DATA: {
    code: "EXPORT_NO_DATA",
    category: "validation",
    httpStatus: 404,
    retryable: false,
    defaultMessage: "No portfolio data matches the selected filters.",
    recoveryNote: "Try broadening the selection filters.",
  },
  EXPORT_SIZE_LIMIT_EXCEEDED: {
    code: "EXPORT_SIZE_LIMIT_EXCEEDED",
    category: "validation",
    httpStatus: 413,
    retryable: false,
    defaultMessage: "The export exceeds the configured response-size limit.",
    recoveryNote: "Try narrowing the time range or asset classes.",
  },
  NO_TRANSACTIONS: {
    code: "NO_TRANSACTIONS",
    category: "validation",
    httpStatus: 404,
    retryable: false,
    defaultMessage: "No transactions found for this address.",
    recoveryNote: "Verify the wallet address and ensure it has transaction history.",
  },
  PREVIEW_WARNINGS_PRESENT: {
    code: "PREVIEW_WARNINGS_PRESENT",
    category: "validation",
    httpStatus: 409,
    retryable: false,
    defaultMessage: "The export preview has blocking warnings that must be resolved first.",
    recoveryNote: "Review the export preview for warnings and resolve them.",
  },
  IDEMPOTENCY_KEY_MISMATCH: {
    code: "IDEMPOTENCY_KEY_MISMATCH",
    category: "validation",
    httpStatus: 422,
    retryable: false,
    defaultMessage: "The idempotency key has already been used with different parameters.",
    recoveryNote: "Use a unique idempotency key for each unique request.",
  },

  // Timeout
  EXPORT_TIMEOUT: {
    code: "EXPORT_TIMEOUT",
    category: "timeout",
    httpStatus: 504,
    retryable: true,
    defaultMessage: "The export took too long and was cancelled. Please retry.",
    recoveryNote: "The system is under high load. Retry after a few minutes.",
  },

  // Service failures
  EXPORT_SERVICE_UNAVAILABLE: {
    code: "EXPORT_SERVICE_UNAVAILABLE",
    category: "service_failure",
    httpStatus: 503,
    retryable: true,
    defaultMessage: "A dependency required for this export is temporarily unavailable.",
    recoveryNote: "Check if the required dependent services are running and accessible.",
  },
  EXPORT_SERVICE_FAILURE: {
    code: "EXPORT_SERVICE_FAILURE",
    category: "service_failure",
    httpStatus: 500,
    retryable: true,
    defaultMessage: "Failed to generate export.",
    recoveryNote: "Investigate server logs for underlying service exceptions.",
  },
  EXPORT_FAILED: {
    code: "EXPORT_FAILED",
    category: "service_failure",
    httpStatus: 500,
    retryable: true,
    defaultMessage: "Failed to generate export.",
    recoveryNote: "Investigate server logs for underlying service exceptions.",
  },
  EXPORT_PREVIEW_FAILED: {
    code: "EXPORT_PREVIEW_FAILED",
    category: "service_failure",
    httpStatus: 500,
    retryable: true,
    defaultMessage: "Failed to build export preview.",
    recoveryNote: "Investigate server logs for underlying preview generation exceptions.",
  },
  DB_UNAVAILABLE: {
    code: "DB_UNAVAILABLE",
    category: "service_failure",
    httpStatus: 503,
    retryable: true,
    defaultMessage: "Export database is unavailable.",
    recoveryNote: "Check if the database is reachable and accepting connections.",
  },
};

// ── Lookup helpers ────────────────────────────────────────────────────────

/** Returns the descriptor for a code, or undefined if unrecognised. */
export function lookupExportFailure(code: string): ExportFailureDescriptor | undefined {
  return EXPORT_FAILURES[code as ExportFailureCode];
}

/** True when `code` is a known, stable export failure code. */
export function isExportFailureCode(code: string): code is ExportFailureCode {
  return Object.prototype.hasOwnProperty.call(EXPORT_FAILURES, code);
}

// ── Error class ───────────────────────────────────────────────────────────

/**
 * Typed error carrying a stable export failure code, its category, the HTTP
 * status it should map to, and whether a retry may succeed.
 */
export class ExportFailureError extends Error {
  code: string;
  category: ExportFailureCategory;
  statusCode: number;
  retryable: boolean;
  details?: Record<string, unknown>;

  constructor(
    code: ExportFailureCode,
    message?: string,
    details?: Record<string, unknown>,
    statusCode?: number,
  ) {
    const descriptor = EXPORT_FAILURES[code];
    super(message ?? descriptor.defaultMessage);
    this.name = "ExportFailureError";
    this.code = descriptor.code;
    this.category = descriptor.category;
    this.statusCode = statusCode ?? descriptor.httpStatus;
    this.retryable = descriptor.retryable;
    this.details = details;
  }

  /**
   * Build an instance from an already-resolved failure. Foreign codes (e.g.
   * treasury validation codes) are preserved verbatim along with the category
   * and status produced by {@link toExportFailure}.
   */
  static from(failure: ResolvedExportFailure): ExportFailureError {
    if (failure instanceof ExportFailureError) {
      return failure;
    }
    const known = isExportFailureCode(failure.code);
    const error = new ExportFailureError(
      known ? failure.code : "EXPORT_SERVICE_FAILURE",
      failure.message,
      (failure.details as Record<string, unknown> | undefined) ?? (known ? undefined : { causeCode: failure.code }),
      failure.httpStatus,
    );
    if (!known) {
      error.code = failure.code;
      error.category = failure.category;
      error.retryable = failure.retryable;
    }
    return error;
  }
}

// ── Resolution ────────────────────────────────────────────────────────────

export interface ResolvedExportFailure {
  code: string;
  category: ExportFailureCategory;
  httpStatus: number;
  retryable: boolean;
  message: string;
  details?: unknown;
}

/**
 * Transport/OS error codes that indicate a connection-level dependency issue
 * rather than an application bug.
 */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

/** Error codes / names that unambiguously indicate a timeout. */
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TIMEOUT_ERROR_NAMES = new Set(["TimeoutError", "AbortTimeoutError"]);

interface CodedErrorLike {
  code?: unknown;
  statusCode?: unknown;
  name?: unknown;
  message?: unknown;
  details?: unknown;
}

/**
 * Deterministically classify any thrown value into a resolved export failure.
 *
 * Classification never parses provider message strings — only error names,
 * machine-readable codes, and status codes are inspected:
 *
 *  1. `ExportFailureError` instances pass through unchanged.
 *  2. Timeout-shaped errors (TimeoutError / ETIMEDOUT / undici timeouts) →
 *     EXPORT_TIMEOUT.
 *  3. Known export failure codes resolve straight from the catalog.
 *  4. Connection-level codes → EXPORT_SERVICE_UNAVAILABLE.
 *  5. Foreign coded errors (e.g. TreasuryValidationError) keep their code;
 *     4xx statuses classify as validation, 5xx as service_failure.
 *  6. Anything else → EXPORT_SERVICE_FAILURE.
 */
export function toExportFailure(err: unknown): ResolvedExportFailure {
  if (err instanceof ExportFailureError) {
    return {
      code: err.code,
      category: err.category,
      httpStatus: err.statusCode,
      retryable: err.retryable,
      message: err.message,
      details: err.details,
    };
  }

  const source = (err ?? {}) as CodedErrorLike;
  const rawCode = typeof source.code === "string" && source.code.length > 0 ? source.code : undefined;
  const rawName = typeof source.name === "string" ? source.name : undefined;
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof source.message === "string"
        ? source.message
        : "Failed to generate export.";

  // 2. Timeout-shaped errors.
  if (
    (rawName !== undefined && TIMEOUT_ERROR_NAMES.has(rawName)) ||
    (rawCode !== undefined && TIMEOUT_ERROR_CODES.has(rawCode))
  ) {
    const descriptor = EXPORT_FAILURES.EXPORT_TIMEOUT;
    return {
      code: descriptor.code,
      category: descriptor.category,
      httpStatus: descriptor.httpStatus,
      retryable: descriptor.retryable,
      message: rawMessage,
      details: rawCode !== undefined ? { causeCode: rawCode } : undefined,
    };
  }

  // 3. Known export failure codes (from ExportSizeLimitExceededError, legacy routes, …).
  if (rawCode !== undefined && isExportFailureCode(rawCode)) {
    const descriptor = EXPORT_FAILURES[rawCode];
    return {
      code: descriptor.code,
      category: descriptor.category,
      httpStatus: descriptor.httpStatus,
      retryable: descriptor.retryable,
      message: rawMessage,
      details: source.details,
    };
  }

  // 4. Connection-level dependency failures.
  if (rawCode !== undefined && CONNECTION_ERROR_CODES.has(rawCode)) {
    const descriptor = EXPORT_FAILURES.EXPORT_SERVICE_UNAVAILABLE;
    return {
      code: descriptor.code,
      category: descriptor.category,
      httpStatus: descriptor.httpStatus,
      retryable: descriptor.retryable,
      // Deliberately not the raw message: connection errors can leak hosts/ports.
      message: descriptor.defaultMessage,
      details: { causeCode: rawCode },
    };
  }

  // 5. Foreign coded errors (TreasuryValidationError, RebalancingPreviewError, …).
  if (rawCode !== undefined && typeof source.statusCode === "number") {
    const httpStatus = source.statusCode;
    return {
      code: rawCode,
      category: httpStatus >= 400 && httpStatus < 500 ? "validation" : "service_failure",
      httpStatus,
      retryable: httpStatus >= 500,
      message: rawMessage,
      details: source.details,
    };
  }

  // 6. Unclassified → generic service failure (raw message not exposed).
  const descriptor = EXPORT_FAILURES.EXPORT_SERVICE_FAILURE;
  return {
    code: descriptor.code,
    category: descriptor.category,
    httpStatus: descriptor.httpStatus,
    retryable: descriptor.retryable,
    message: descriptor.defaultMessage,
  };
}
