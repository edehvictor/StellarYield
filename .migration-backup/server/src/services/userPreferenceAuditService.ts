/**
 * User Preference Audit Service (#1311)
 *
 * Generic backend audit trail for non-alert user preference changes
 * (digest preferences, digest schedule settings, notification prefs, etc.).
 *
 * Alert preference changes continue to use `alertPreferenceAuditService`
 * (vault-scoped AlertPreferences snapshots). This service records wallet-scoped
 * preference changes of any shape so support can reconstruct what changed,
 * when, and by whom.
 */

export type PreferenceAuditSource = "api" | "system" | "admin" | "revert";

/** Preference categories recorded by this service. */
export type PreferenceCategory =
  | "digest_preference"
  | "digest_schedule"
  | "notification_preference"
  | "other";

export interface UserPreferenceAuditEntry {
  id: string;
  walletAddress: string;
  category: PreferenceCategory;
  actor: string;
  timestamp: string;
  source: PreferenceAuditSource;
  before: unknown;
  after: unknown;
  reason?: string;
}

const auditStore = new Map<string, UserPreferenceAuditEntry[]>();

/** Maximum audit entries retained per wallet. */
const MAX_AUDIT_ENTRIES = 100;

function storeKey(walletAddress: string): string {
  return walletAddress.toLowerCase();
}

let auditIdCounter = 0;

export function recordUserPreferenceChange(params: {
  walletAddress: string;
  category: PreferenceCategory;
  actor: string;
  source: PreferenceAuditSource;
  before: unknown;
  after: unknown;
  reason?: string;
}): UserPreferenceAuditEntry {
  auditIdCounter += 1;

  const entry: UserPreferenceAuditEntry = {
    id: `upa-${auditIdCounter}`,
    walletAddress: params.walletAddress,
    category: params.category,
    actor: params.actor,
    timestamp: new Date().toISOString(),
    source: params.source,
    before: params.before,
    after: params.after,
    reason: params.reason,
  };

  const key = storeKey(params.walletAddress);
  const existing = auditStore.get(key) ?? [];
  auditStore.set(key, [entry, ...existing].slice(0, MAX_AUDIT_ENTRIES));
  return entry;
}

/**
 * Retrieve audit history for a wallet, newest first.
 * When `category` is provided, only that category is returned.
 */
export function getUserPreferenceAuditHistory(
  walletAddress: string,
  category?: PreferenceCategory,
): UserPreferenceAuditEntry[] {
  const history = auditStore.get(storeKey(walletAddress)) ?? [];
  return category ? history.filter((e) => e.category === category) : history;
}

export function getUserPreferenceAuditEntryCount(walletAddress: string): number {
  return auditStore.get(storeKey(walletAddress))?.length ?? 0;
}

/** Reset the audit store. Intended for testing only. */
export function resetUserPreferenceAuditStore(): void {
  auditStore.clear();
  auditIdCounter = 0;
}
