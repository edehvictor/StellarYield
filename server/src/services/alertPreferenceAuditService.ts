/**
 * Alert Preference Audit Service
 *
 * Records every alert preference change with actor, timestamp, and source
 * so support can trace accidental dismissals or misconfigurations.
 *
 * Each entry captures:
 *  - walletAddress + vaultId (scoped to the user+vault pair)
 *  - actor who made the change
 *  - timestamp of the change
 *  - source (api | system | admin | revert)
 *  - before / after preference snapshots
 *  - optional reason for the change
 */

import type { AlertPreferences } from "./alertsPreferenceRules";

// ── Types ──────────────────────────────────────────────────────────────

export type AuditSource = "api" | "system" | "admin" | "revert";

export interface AlertPreferenceAuditEntry {
  /** Unique identifier for this audit entry */
  id: string;
  /** Wallet address that owns the alert preferences */
  walletAddress: string;
  /** Vault that the preferences apply to */
  vaultId: string;
  /** Identity of the actor who made the change (wallet address, "system", "admin") */
  actor: string;
  /** ISO-8601 timestamp when the change was recorded */
  timestamp: string;
  /** How the change was triggered */
  source: AuditSource;
  /** Snapshot of preferences before the change (null for initial creation) */
  before: AlertPreferences | null;
  /** Snapshot of preferences after the change */
  after: AlertPreferences;
  /** Optional human-readable reason for the change */
  reason?: string;
}

// ── In-Memory Persistence Store ─────────────────────────────────────────

const auditStore = new Map<string, AlertPreferenceAuditEntry[]>();

/** Maximum audit entries retained per wallet+vault pair. */
const MAX_AUDIT_ENTRIES = 100;

function auditStoreKey(walletAddress: string, vaultId: string): string {
  return `${walletAddress.toLowerCase()}::${vaultId.toLowerCase()}`;
}

/** Monotonically-increasing counter for unique audit entry IDs. */
let auditIdCounter = 0;

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Record a preference change in the audit trail.
 *
 * @returns The created audit entry.
 */
export function recordPreferenceChange(params: {
  walletAddress: string;
  vaultId: string;
  actor: string;
  source: AuditSource;
  before: AlertPreferences | null;
  after: AlertPreferences;
  reason?: string;
}): AlertPreferenceAuditEntry {
  auditIdCounter += 1;

  const entry: AlertPreferenceAuditEntry = {
    id: `audit-${auditIdCounter}`,
    walletAddress: params.walletAddress,
    vaultId: params.vaultId,
    actor: params.actor,
    timestamp: new Date().toISOString(),
    source: params.source,
    before: params.before,
    after: { ...params.after },
    reason: params.reason,
  };

  const key = auditStoreKey(params.walletAddress, params.vaultId);
  const existing = auditStore.get(key) ?? [];
  // Newest entries first
  auditStore.set(key, [entry, ...existing].slice(0, MAX_AUDIT_ENTRIES));

  return entry;
}

/**
 * Retrieve the full audit history for a wallet+vault pair, ordered newest-first.
 */
export function getPreferenceAuditHistory(
  walletAddress: string,
  vaultId: string,
): AlertPreferenceAuditEntry[] {
  const key = auditStoreKey(walletAddress, vaultId);
  return auditStore.get(key) ?? [];
}

/**
 * Retrieve a single audit entry by its ID.
 */
export function getAuditEntryById(
  walletAddress: string,
  vaultId: string,
  entryId: string,
): AlertPreferenceAuditEntry | undefined {
  const history = getPreferenceAuditHistory(walletAddress, vaultId);
  return history.find((e) => e.id === entryId);
}

/**
 * Find the most recent audit entry whose `after` preferences can be reverted to.
 * This is typically the entry immediately before the current one (index 1,
 * since index 0 is the latest).
 */
export function findRevertTarget(
  walletAddress: string,
  vaultId: string,
): AlertPreferenceAuditEntry | undefined {
  const history = getPreferenceAuditHistory(walletAddress, vaultId);
  // The entry to revert *to* is the second entry (the one before the latest change)
  if (history.length >= 2) {
    return history[1];
  }
  return undefined;
}

/**
 * Reset the audit store. Intended for testing only.
 */
export function resetAuditStore(): void {
  auditStore.clear();
  auditIdCounter = 0;
}

/**
 * Return the number of audit entries for a wallet+vault pair.
 */
export function getAuditEntryCount(
  walletAddress: string,
  vaultId: string,
): number {
  const key = auditStoreKey(walletAddress, vaultId);
  return auditStore.get(key)?.length ?? 0;
}
