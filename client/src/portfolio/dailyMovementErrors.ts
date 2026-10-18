/**
 * Client-side error/freshness messaging for daily-movement reads (#1362).
 *
 * Maps the API guardrail codes (`STALE_VALUATION_SNAPSHOT`, 404
 * `SNAPSHOT_NOT_FOUND`, `INVALID_QUERY`, …) to stable human messages without
 * ever surfacing raw provider output, and formats the additive `freshness`
 * annotation for the movement panel.
 */

import type { ValuationFreshness } from "../../../shared/types/dailyMovement";

/** Stable, user-presentable description of a failed daily-movement request. */
export interface DailyMovementFailure {
  /** Machine-readable code (server `error` field or a local fallback). */
  code: string;
  /** Human-readable message safe to render directly. */
  message: string;
  /** HTTP status of the failed response (0 when the request never completed). */
  status: number;
  /** Whether retrying the same request may succeed later. */
  retryable: boolean;
}

/** Typed error thrown by `useDailyMovement` instead of a bare `Error`. */
export class DailyMovementError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(failure: DailyMovementFailure) {
    super(failure.message);
    this.name = "DailyMovementError";
    this.code = failure.code;
    this.status = failure.status;
    this.retryable = failure.retryable;
  }
}

interface KnownFailureCopy {
  message: string;
  retryable: boolean;
}

const KNOWN_FAILURES: Record<string, KnownFailureCopy> = {
  STALE_VALUATION_SNAPSHOT: {
    message:
      "Portfolio valuation snapshot is stale. Try again after the next snapshot refresh.",
    retryable: true,
  },
  SNAPSHOT_NOT_FOUND: {
    message: "No portfolio snapshot is available for this wallet yet.",
    retryable: false,
  },
  INVALID_QUERY: {
    message: "The freshness guardrail parameters were rejected by the server.",
    retryable: false,
  },
  INVALID_ADDRESS: {
    message: "Invalid Stellar wallet address.",
    retryable: false,
  },
  DAILY_MOVEMENT_FAILED: {
    message: "Failed to fetch daily movement.",
    retryable: true,
  },
};

function fallbackCodeForStatus(status: number): string {
  if (status === 404) return "SNAPSHOT_NOT_FOUND";
  if (status === 400) return "INVALID_QUERY";
  if (status === 409) return "STALE_VALUATION_SNAPSHOT";
  if (status === 0) return "NETWORK_ERROR";
  return "DAILY_MOVEMENT_FAILED";
}

/**
 * Describe a failed daily-movement response using only stable server codes;
 * unknown or missing bodies fall back to status-based copy so raw provider
 * or upstream HTML never reaches the UI.
 */
export function describeDailyMovementFailure(
  status: number,
  body: unknown,
): DailyMovementFailure {
  const parsed =
    body !== null && typeof body === "object"
      ? (body as { error?: unknown; message?: unknown })
      : null;

  const code =
    typeof parsed?.error === "string" && parsed.error.length > 0
      ? parsed.error
      : fallbackCodeForStatus(status);

  const known = KNOWN_FAILURES[code];
  const serverMessage =
    typeof parsed?.message === "string" && parsed.message.trim().length > 0
      ? parsed.message
      : null;

  return {
    code,
    message: serverMessage ?? known?.message ?? "Failed to fetch daily movement.",
    status,
    retryable: known?.retryable ?? (status >= 500 || status === 0),
  };
}

function formatAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours}h`;
  return `${Math.floor(totalHours / 24)}d`;
}

/**
 * Human-readable staleness notice for the movement panel, or `null` when
 * freshness data is absent or the snapshot is fresh (nothing to warn about).
 */
export function describeFreshnessNotice(
  freshness: ValuationFreshness | undefined,
): string | null {
  if (!freshness || !freshness.isStale) {
    return null;
  }

  if (freshness.snapshotValuedAt === null || freshness.ageMs === null) {
    return "No valuation snapshot available — figures may be out of date.";
  }

  return `Valuation snapshot may be stale: last updated ${formatAge(
    freshness.ageMs,
  )} ago (limit ${formatAge(freshness.maxAgeMs)}).`;
}
