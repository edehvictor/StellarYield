/**
 * Bridge transfer status reconciliation for delayed confirmations (#1168).
 *
 * Reconciles a single tracked bridge transfer against a fresh confirmation
 * check, updating its state in place (never duplicating the record) so a
 * transfer that stays pending past the expected confirmation window
 * surfaces as "delayed" and keeps refreshing until it resolves.
 */

export type BridgeTransferState = "pending" | "delayed" | "confirmed" | "failed";

export interface BridgeTransferRecord {
  transferId: string;
  /** ISO 8601 timestamp the transfer was initiated. */
  initiatedAt: string;
  /** ISO 8601 timestamp this record was last refreshed. */
  lastCheckedAt: string;
  /** Which confirmation source last reported on this transfer (relayer, indexer, etc.), if any. */
  confirmationSource: string | null;
  state: BridgeTransferState;
  /** Most recent known failure/delay reason, if any. */
  lastKnownReason: string | null;
}

export interface ConfirmationCheck {
  confirmed: boolean;
  source: string;
  reason?: string;
}

/** A transfer still pending past this window is reclassified as "delayed". */
const CONFIRMATION_WINDOW_MS = 30 * 60 * 1000;
const FAILURE_REASON_PATTERN = /fail|reject|revert/i;

/**
 * Reconcile `record` against a fresh `check` result, returning an updated
 * copy of the same record (same `transferId`) rather than a new one, so
 * repeated refreshes never duplicate a transfer.
 */
export function reconcileTransferStatus(
  record: BridgeTransferRecord,
  check: ConfirmationCheck,
  now: Date = new Date(),
): BridgeTransferRecord {
  if (record.state === "confirmed" || record.state === "failed") {
    // Terminal states don't get refreshed further.
    return record;
  }

  if (check.confirmed) {
    return {
      ...record,
      state: "confirmed",
      lastCheckedAt: now.toISOString(),
      confirmationSource: check.source,
      lastKnownReason: null,
    };
  }

  if (check.reason && FAILURE_REASON_PATTERN.test(check.reason)) {
    return {
      ...record,
      state: "failed",
      lastCheckedAt: now.toISOString(),
      confirmationSource: check.source,
      lastKnownReason: check.reason,
    };
  }

  const initiatedAt = new Date(record.initiatedAt);
  const elapsedMs = now.getTime() - initiatedAt.getTime();
  const state: BridgeTransferState = elapsedMs > CONFIRMATION_WINDOW_MS ? "delayed" : "pending";

  return {
    ...record,
    state,
    lastCheckedAt: now.toISOString(),
    confirmationSource: check.source,
    lastKnownReason: check.reason ?? record.lastKnownReason,
  };
}
