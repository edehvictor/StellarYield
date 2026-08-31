import { getProviderRetryMetadata, RetryBudgetMetadata } from "../agents/resilientFetch";

export type FreshnessStatus = "fresh" | "aging" | "stale" | "expired" | "unknown" | "exhausted";
export type FreshnessSeverity = "ok" | "warning" | "critical" | "unknown";

export interface FreshnessThresholds {
  /** Age (ms) at or below which a source counts as fresh. */
  freshWindowMs: number;
  /** Age (ms) at or below which a source counts as aging. */
  agingWindowMs: number;
  /** Age (ms) at or below which a source counts as stale. Older data is expired. */
  staleWindowMs: number;
}

export const DEFAULT_FRESHNESS_THRESHOLDS: FreshnessThresholds = {
  freshWindowMs: 5 * 60 * 1000,
  agingWindowMs: 60 * 60 * 1000,
  staleWindowMs: 24 * 60 * 60 * 1000,
};

export interface FreshnessResult {
  status: FreshnessStatus;
  severity: FreshnessSeverity;
  /** Age of the data in seconds, or null when fetchedAt is unknown. */
  ageSeconds: number | null;
  /** The evaluated fetchedAt timestamp (normalized to ISO-8601), or null if absent/invalid. */
  fetchedAt: string | null;
  /** Structured retry budget metadata if available. */
  retryBudget?: RetryBudgetMetadata;
}

function severityForStatus(status: FreshnessStatus): FreshnessSeverity {
  switch (status) {
    case "fresh":
      return "ok";
    case "aging":
    case "stale":
      return "warning";
    case "expired":
    case "exhausted":
      return "critical";
    default:
      return "unknown";
  }
}

function classifyFreshness(ageMs: number, thresholds: FreshnessThresholds): FreshnessStatus {
  if (ageMs <= thresholds.freshWindowMs) return "fresh";
  if (ageMs <= thresholds.agingWindowMs) return "aging";
  if (ageMs <= thresholds.staleWindowMs) return "stale";
  return "expired";
}

export function computeFreshnessStatus(
  fetchedAt: string | null | undefined,
  now: Date = new Date(),
  thresholds: FreshnessThresholds = DEFAULT_FRESHNESS_THRESHOLDS,
  providerId?: string,
  isExhausted?: boolean,
): FreshnessResult {
  const retryBudget = providerId ? getProviderRetryMetadata(providerId) : undefined;
  const exhausted = isExhausted ?? retryBudget?.exhausted ?? false;

  const parsed = fetchedAt ? new Date(fetchedAt) : null;
  const validDate = parsed && !Number.isNaN(parsed.getTime());
  const ageSeconds = validDate
    ? Math.max(0, Math.round((now.getTime() - parsed.getTime()) / 1000))
    : null;
  const normalizedFetchedAt = validDate ? parsed.toISOString() : null;

  if (exhausted) {
    return {
      status: "exhausted",
      severity: severityForStatus("exhausted"),
      ageSeconds,
      fetchedAt: normalizedFetchedAt,
      retryBudget,
    };
  }

  if (!validDate || ageSeconds === null) {
    return { status: "unknown", severity: "unknown", ageSeconds: null, fetchedAt: null, retryBudget };
  }

  const ageMs = Math.max(0, now.getTime() - parsed.getTime());
  const status = classifyFreshness(ageMs, thresholds);

  return {
    status,
    severity: severityForStatus(status),
    ageSeconds,
    fetchedAt: normalizedFetchedAt,
    retryBudget,
  };
}