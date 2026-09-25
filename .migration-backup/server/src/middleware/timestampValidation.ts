/**
 * Timestamp Validation Middleware
 *
 * Rejects protected API requests when the `X-Signed-Timestamp` header is
 * missing, outside the allowed clock window, or not a valid timestamp.
 *
 * The allowed clock skew is configurable via `TimestampValidationOptions` so
 * integration tests and different deployment environments can tune the window
 * without patching the middleware.
 *
 * Error responses use the shared API error catalog codes so the client can
 * apply the correct recovery action:
 *
 *   TIMESTAMP_MISSING  — header absent entirely
 *   TIMESTAMP_INVALID  — header present but not parseable as a timestamp
 *   TIMESTAMP_EXPIRED  — too far in the past (> allowedSkewMs)
 *   TIMESTAMP_FUTURE   — too far in the future (> allowedSkewMs)
 */

import { Request, Response, NextFunction } from "express";
import { catalogError } from "../utils/catalogErrorResponse";
import { API_ERRORS } from "../types/apiErrorCatalog";

export const TIMESTAMP_HEADER = "x-signed-timestamp";

/**
 * Clock skew defaults.  The RFC 6749 / NTP community convention is ±5 minutes
 * for token acceptance windows; we use the same default here.
 */
export const DEFAULT_ALLOWED_SKEW_MS = 5 * 60 * 1000; // 5 minutes

export interface TimestampValidationOptions {
  /**
   * Maximum age of the timestamp in milliseconds.  Requests with a timestamp
   * older than `now - allowedSkewMs` are rejected as TIMESTAMP_EXPIRED.
   * Requests with a timestamp newer than `now + allowedSkewMs` are rejected
   * as TIMESTAMP_FUTURE.
   *
   * @default 300_000 (5 minutes)
   */
  allowedSkewMs?: number;

  /**
   * Override the "now" clock — useful in tests to simulate different time
   * scenarios without mocking `Date`.
   *
   * @default () => Date.now()
   */
  now?: () => number;
}

/**
 * Parse the header value into a Unix millisecond timestamp.
 *
 * Accepts:
 *   - ISO-8601 date strings     (e.g. "2024-05-01T12:00:00.000Z")
 *   - Unix epoch seconds        (e.g. "1714557600")
 *   - Unix epoch milliseconds   (e.g. "1714557600000")
 *
 * Returns `null` if the value cannot be interpreted as a timestamp.
 */
export function parseTimestampHeader(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Try ISO-8601 string first (non-purely-numeric)
  if (!/^-?\d+$/.test(trimmed)) {
    const ms = Date.parse(trimmed);
    // Reject non-finite results and dates before Unix epoch (year 1970)
    return isNaN(ms) || ms < 0 ? null : ms;
  }

  // Numeric string — reject zero and negatives
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;

  // Distinguish seconds vs milliseconds by magnitude.
  // Unix epoch in seconds at year 2100 ≈ 4_102_444_800 (10 digits)
  // Unix epoch in ms at year 2100 ≈ 4_102_444_800_000 (13 digits)
  return n <= 9_999_999_999 ? n * 1_000 : n;
}

/**
 * Build a `requireTimestamp` middleware with the given options.
 *
 * @example
 * ```ts
 * // Default 5-minute window
 * router.post("/protected", requireTimestamp(), handler);
 *
 * // Custom 30-second window for high-frequency endpoints
 * router.post("/fast", requireTimestamp({ allowedSkewMs: 30_000 }), handler);
 * ```
 */
export function requireTimestamp(options: TimestampValidationOptions = {}) {
  const allowedSkewMs = options.allowedSkewMs ?? DEFAULT_ALLOWED_SKEW_MS;
  const clock = options.now ?? (() => Date.now());

  return function timestampValidationMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const raw = req.headers[TIMESTAMP_HEADER];

    // ── 1. Missing header ────────────────────────────────────────────────
    if (raw === undefined || raw === "") {
      catalogError(res, API_ERRORS.TIMESTAMP_MISSING);
      return;
    }

    const headerValue = Array.isArray(raw) ? raw[0] : raw;

    // ── 2. Unparseable value ─────────────────────────────────────────────
    const requestTimeMs = parseTimestampHeader(headerValue);
    if (requestTimeMs === null) {
      catalogError(res, API_ERRORS.TIMESTAMP_INVALID, undefined, {
        received: headerValue,
      });
      return;
    }

    const nowMs = clock();
    const diffMs = requestTimeMs - nowMs;

    // ── 3. Too far in the future ─────────────────────────────────────────
    if (diffMs > allowedSkewMs) {
      catalogError(
        res,
        API_ERRORS.TIMESTAMP_FUTURE,
        `Timestamp is ${Math.round(diffMs / 1000)}s in the future. Allowed skew is ${Math.round(allowedSkewMs / 1000)}s.`,
        { diffMs, allowedSkewMs },
      );
      return;
    }

    // ── 4. Too far in the past ───────────────────────────────────────────
    if (-diffMs > allowedSkewMs) {
      catalogError(
        res,
        API_ERRORS.TIMESTAMP_EXPIRED,
        `Timestamp expired ${Math.round(-diffMs / 1000)}s ago. Allowed skew is ${Math.round(allowedSkewMs / 1000)}s.`,
        { diffMs, allowedSkewMs },
      );
      return;
    }

    // ── 5. Valid — attach parsed timestamp to request for downstream use ─
    (req as Request & { signedTimestampMs?: number }).signedTimestampMs =
      requestTimeMs;
    next();
  };
}
