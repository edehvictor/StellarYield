/**
 * Shared deterministic response envelope for analytics and treasury routes.
 *
 * Every successful response carries { ok: true, data, meta } and every error
 * response carries { ok: false, error }.  Consumers can always branch on `ok`
 * without inspecting HTTP status codes or unpredictable field names.
 */

// ── Metadata ──────────────────────────────────────────────────────────────

export interface ResponseMeta {
  /** ISO-8601 timestamp of when this response was generated. */
  generatedAt: string;
  /** Identifies which route/resource generated the response. */
  route: string;
  /** Optional non-fatal warnings (e.g. stale data, partial results). */
  warnings?: string[];
}

// ── Success envelope ──────────────────────────────────────────────────────

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  meta: ResponseMeta;
}

// ── Error detail ──────────────────────────────────────────────────────────

export interface ErrorDetail {
  /** Machine-readable error code (e.g. "VALIDATION_ERROR", "INTERNAL_ERROR"). */
  code: string;
  /** Human-readable description of the error. */
  message: string;
  /** Optional field-level or contextual details. */
  details?: unknown;
}

// ── Error envelope ────────────────────────────────────────────────────────

export interface ErrorEnvelope {
  ok: false;
  error: ErrorDetail;
  meta: ResponseMeta;
}

// ── Union type ────────────────────────────────────────────────────────────

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

// ── Factory helpers ───────────────────────────────────────────────────────

/**
 * Build a success envelope.
 *
 * @param data    - The response payload.
 * @param route   - The route identifier (e.g. "analytics/attribution").
 * @param warnings - Optional non-fatal warning strings.
 */
export function successEnvelope<T>(
  data: T,
  route: string,
  warnings?: string[],
): SuccessEnvelope<T> {
  const meta: ResponseMeta = {
    generatedAt: new Date().toISOString(),
    route,
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
  return { ok: true, data, meta };
}

/**
 * Build an error envelope.
 *
 * @param code    - Machine-readable error code.
 * @param message - Human-readable error description.
 * @param route   - The route identifier.
 * @param details - Optional extra context (field errors, upstream message…).
 */
export function errorEnvelope(
  code: string,
  message: string,
  route: string,
  details?: unknown,
): ErrorEnvelope {
  const meta: ResponseMeta = {
    generatedAt: new Date().toISOString(),
    route,
  };
  return {
    ok: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
    meta,
  };
}
