/**
 * UI status mapping for the Contract Event Indexer checkpoint panel.
 *
 * Pure and framework-free so the status mapping (including the degraded state)
 * can be unit tested without rendering a component.
 */

import type { StatusVariant } from "../../components/StatusBadge";

export type IndexerHealthStatus = "healthy" | "degraded" | "unavailable";

export interface IndexerReplayError {
  ledger: number | null;
  message: string;
  at: string;
}

export interface IndexerStatus {
  status: IndexerHealthStatus;
  reason: string | null;
  indexedLedger: number | null;
  horizonLedger: number | null;
  lagLedgers: number | null;
  lastIndexedAt: string | null;
  heartbeatAgeSeconds: number | null;
  recentErrors: IndexerReplayError[];
  generatedAt: string;
}

interface StatusDisplay {
  label: string;
  variant: StatusVariant;
  needsAttention: boolean;
}

const STATUS_DISPLAY: Record<IndexerHealthStatus, StatusDisplay> = {
  healthy: { label: "Healthy", variant: "success", needsAttention: false },
  degraded: { label: "Degraded", variant: "warning", needsAttention: true },
  unavailable: { label: "Unavailable", variant: "danger", needsAttention: true },
};

const FALLBACK_DISPLAY: StatusDisplay = {
  label: "Unknown",
  variant: "neutral",
  needsAttention: true,
};

/** Map an indexer status to its badge label/variant. */
export function getIndexerStatusDisplay(
  status: IndexerHealthStatus | string,
): StatusDisplay {
  return STATUS_DISPLAY[status as IndexerHealthStatus] ?? FALLBACK_DISPLAY;
}

/** Human-friendly ledger lag string. */
export function formatLag(lagLedgers: number | null): string {
  if (lagLedgers === null || !Number.isFinite(lagLedgers)) return "unknown";
  if (lagLedgers === 0) return "in sync";
  return `${lagLedgers} ledger${lagLedgers === 1 ? "" : "s"} behind`;
}

/** True when the indexer is degraded or unavailable and needs operator attention. */
export function isIndexerDegraded(status: IndexerStatus): boolean {
  return status.status !== "healthy";
}
