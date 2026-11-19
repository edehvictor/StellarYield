/**
 * API guardrails for stale portfolio valuation snapshots (#1362).
 *
 * Daily-movement reads are backed by `DailyPortfolioSnapshot` rows that are
 * written by an end-of-day job. When that job stalls, clients silently render
 * outdated valuations. This module provides:
 *
 * - a pure freshness evaluator (`evaluateValuationFreshness`)
 * - a typed query-string parser for the opt-in guardrails
 *   (`?requireFresh=true` and `?maxAgeMs=...`) so default requests keep their
 *   existing 200 behavior
 * - typed errors (`FreshnessQueryError`, `StaleValuationError`) the route can
 *   map to stable HTTP codes without leaking internal details
 */

import type { ValuationFreshness } from "../../../shared/types/dailyMovement";

/**
 * Default maximum snapshot age considered fresh: 36 hours.
 *
 * Snapshots are written once per UTC day; a just-written "today" row can
 * legitimately be ~24h old by the end of the day, so the threshold needs
 * slack beyond 24h while still catching a missed write (row older than a
 * day and a half ⇒ at least one expected write did not land).
 */
export const DEFAULT_VALUATION_MAX_AGE_MS = 36 * 60 * 60 * 1000;

/** Upper bound for caller-supplied `maxAgeMs` (7 days). */
export const MAX_ALLOWED_VALUATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Typed validation error for `requireFresh` / `maxAgeMs` query params. */
export class FreshnessQueryError extends Error {
  readonly code = "INVALID_QUERY";
  readonly statusCode = 400;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "FreshnessQueryError";
    this.details = details;
  }
}

/** Typed 409 error raised when `requireFresh=true` and the snapshot is stale. */
export class StaleValuationError extends Error {
  readonly code = "STALE_VALUATION_SNAPSHOT";
  readonly statusCode = 409;
  readonly freshness: ValuationFreshness;

  constructor(freshness: ValuationFreshness) {
    const age =
      freshness.ageMs === null
        ? "missing snapshot"
        : `${Math.round(freshness.ageMs / 1000)}s old`;
    super(
      `Portfolio valuation snapshot is stale (${age}, limit ${Math.round(
        freshness.maxAgeMs / 1000,
      )}s).`,
    );
    this.name = "StaleValuationError";
    this.freshness = freshness;
  }
}

export interface EvaluateValuationFreshnessParams {
  /** Snapshot write time; null/undefined means no snapshot exists. */
  valuedAt: Date | string | null | undefined;
  /** Evaluation clock (epoch ms); defaults to `Date.now()`. */
  now?: number;
  /** Freshness threshold in ms; defaults to `DEFAULT_VALUATION_MAX_AGE_MS`. */
  maxAgeMs?: number;
}

/**
 * Pure freshness evaluation for a valuation snapshot.
 *
 * Never throws: an unusable `valuedAt` is treated the same as a missing
 * snapshot (`ageMs: null`, `isStale: true`) so callers can decide policy.
 */
export function evaluateValuationFreshness(
  params: EvaluateValuationFreshnessParams,
): ValuationFreshness {
  const maxAgeMs = params.maxAgeMs ?? DEFAULT_VALUATION_MAX_AGE_MS;
  const now = params.now ?? Date.now();
  const evaluatedAt = new Date(now).toISOString();

  const missing: ValuationFreshness = {
    evaluatedAt,
    snapshotValuedAt: null,
    ageMs: null,
    maxAgeMs,
    isStale: true,
  };

  if (params.valuedAt === null || params.valuedAt === undefined) {
    return missing;
  }

  const valuedDate =
    typeof params.valuedAt === "string"
      ? new Date(params.valuedAt)
      : params.valuedAt;
  const valuedMs = valuedDate.getTime();
  if (Number.isNaN(valuedMs)) {
    return missing;
  }

  const ageMs = Math.max(0, now - valuedMs);
  return {
    evaluatedAt,
    snapshotValuedAt: valuedDate.toISOString(),
    ageMs,
    maxAgeMs,
    isStale: ageMs > maxAgeMs,
  };
}

export interface ValuationFreshnessQuery {
  /** When true, stale/missing snapshots must fail the request. */
  requireFresh: boolean;
  /** Freshness threshold in ms for this request. */
  maxAgeMs: number;
}

/**
 * Parse the opt-in guardrail query params. Absent params mean "no guard"
 * (requireFresh=false) with the default threshold used only to annotate the
 * response `freshness` field — default behavior is fully backward compatible.
 *
 * @throws {FreshnessQueryError} on malformed values.
 */
export function parseValuationFreshnessQuery(
  query: Record<string, unknown>,
): ValuationFreshnessQuery {
  let requireFresh = false;
  const rawRequireFresh = query.requireFresh;
  if (rawRequireFresh !== undefined) {
    if (typeof rawRequireFresh !== "string") {
      throw new FreshnessQueryError(
        "`requireFresh` must be `true` or `false`.",
        { requireFresh: rawRequireFresh },
      );
    }
    const normalized = rawRequireFresh.trim().toLowerCase();
    if (normalized === "true") {
      requireFresh = true;
    } else if (normalized === "false" || normalized === "") {
      requireFresh = false;
    } else {
      throw new FreshnessQueryError(
        "`requireFresh` must be `true` or `false`.",
        { requireFresh: rawRequireFresh },
      );
    }
  }

  let maxAgeMs = DEFAULT_VALUATION_MAX_AGE_MS;
  const rawMaxAge = query.maxAgeMs;
  if (rawMaxAge !== undefined) {
    if (typeof rawMaxAge !== "string" || !/^\d+$/.test(rawMaxAge.trim())) {
      throw new FreshnessQueryError(
        "`maxAgeMs` must be a positive integer (milliseconds).",
        { maxAgeMs: rawMaxAge },
      );
    }
    const parsed = Number(rawMaxAge);
    if (parsed <= 0 || parsed > MAX_ALLOWED_VALUATION_MAX_AGE_MS) {
      throw new FreshnessQueryError(
        "`maxAgeMs` must be between 1 and 604800000 (7 days).",
        { maxAgeMs: rawMaxAge },
      );
    }
    maxAgeMs = parsed;
  }

  return { requireFresh, maxAgeMs };
}

/**
 * Gate a response behind `requireFresh`. Throws `StaleValuationError` when
 * the annotated freshness is stale or the snapshot is missing.
 *
 * @throws {StaleValuationError}
 */
export function assertFreshValuation(freshness: ValuationFreshness): void {
  if (freshness.isStale) {
    throw new StaleValuationError(freshness);
  }
}
