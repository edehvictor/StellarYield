/**
 * UI status mapping for the Yield Data Source Health dashboard.
 *
 * Keeps the mapping from backend status -> visual presentation pure and
 * framework-free so it can be unit tested without rendering a component.
 */

import type { StatusVariant } from "../../components/StatusBadge";

export type SourceHealthStatus =
  | "healthy"
  | "degraded"
  | "stale"
  | "unavailable";

export interface SourceHealthSummary {
  providerId: string;
  providerName: string;
  dataSource: string;
  status: SourceHealthStatus;
  reliabilityScore: number;
  uptimePct: number;
  freshnessPct: number;
  errorRatePct: number;
  latencyMs: number;
  latestFetch: string;
  ageSeconds: number;
  consecutiveFailures: number;
  failureReason: string | null;
  trend: "improving" | "stable" | "declining";
}

export interface SourceHealthRegistry {
  generatedAt: string;
  totalSources: number;
  counts: Record<SourceHealthStatus, number>;
  sources: SourceHealthSummary[];
}

interface StatusDisplay {
  label: string;
  variant: StatusVariant;
  /** Whether this status should draw operator attention. */
  needsAttention: boolean;
}

const STATUS_DISPLAY: Record<SourceHealthStatus, StatusDisplay> = {
  healthy: { label: "Healthy", variant: "success", needsAttention: false },
  degraded: { label: "Degraded", variant: "warning", needsAttention: true },
  stale: { label: "Stale", variant: "warning", needsAttention: true },
  unavailable: { label: "Unavailable", variant: "danger", needsAttention: true },
};

const FALLBACK_DISPLAY: StatusDisplay = {
  label: "Unknown",
  variant: "neutral",
  needsAttention: true,
};

/** Map a source status to its badge label/variant. */
export function getSourceStatusDisplay(
  status: SourceHealthStatus | string,
): StatusDisplay {
  return STATUS_DISPLAY[status as SourceHealthStatus] ?? FALLBACK_DISPLAY;
}

/** Human-friendly latency string. */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Human-friendly "time since last fetch" string. */
export function formatAge(ageSeconds: number): string {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return "unknown";
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/** True when any source is not healthy. */
export function hasUnhealthySources(registry: SourceHealthRegistry): boolean {
  return (
    registry.counts.degraded +
      registry.counts.stale +
      registry.counts.unavailable >
    0
  );
}
