/**
 * Protocol fee history (#1147).
 *
 * Tracks recent changes to a yield source's protocol fee (management fee +
 * performance fee, combined into a single total-fee figure in basis points)
 * so the yield-source detail view can show "what changed recently" rather
 * than only the current value.
 *
 * Storage approach: this codebase's protocol fee values (`managementFeeBps`
 * / `performanceFeeBps` in `config/protocols.ts`) are static per-deployment
 * config, not backed by any live on-chain or admin-editable source — there
 * is no existing "fee change" event to subscribe to, and no other fee-like
 * history in this codebase is Prisma-backed either (the closest analogue,
 * `SharePriceSnapshot`, is defined in the schema but not currently written
 * by any service). Given that, adding a full Prisma migration+table for a
 * value that never actually changes at runtime today would be
 * over-engineered relative to what the codebase currently needs.
 *
 * Instead this follows the same "snapshot on change" idea using the
 * in-memory pattern already established elsewhere in this codebase (e.g.
 * `yieldSourceRegistryService`'s NodeCache-backed registry): a snapshot is
 * recorded only when the observed fee differs from the last recorded value
 * for that protocol, deduplicating no-op writes. `recordFeeSnapshotIfChanged`
 * is called on every yield-data refresh cycle (`buildProtocolSnapshot` in
 * `yieldService.ts`, every `CURRENT_YIELDS_TTL_SECONDS`), so a real fee
 * change — whether from a future config update or a live admin/on-chain
 * source wired in later — is captured automatically without further
 * plumbing changes. Should a future need arise to persist this across
 * server restarts, the same shape can be lifted into a Prisma table
 * (`ProtocolFeeSnapshot`) following the `SharePriceSnapshot` model as a
 * template, with `recordFeeSnapshotIfChanged` swapped for a DB write.
 */

export interface ProtocolFeeSnapshot {
  /** Combined management + performance fee, in basis points. */
  feeBps: number;
  changedAt: string;
}

/** Maximum number of recent snapshots retained per protocol. */
export const MAX_FEE_HISTORY_ENTRIES = 20;

// protocolName -> snapshots, newest last (appended chronologically).
const feeHistory = new Map<string, ProtocolFeeSnapshot[]>();

/**
 * Records a fee snapshot for `protocolName` if `feeBps` differs from the
 * most recently recorded value (or none has been recorded yet). No-ops on
 * an unchanged value so repeated calls with the same fee across refresh
 * cycles don't create redundant entries.
 */
export function recordFeeSnapshotIfChanged(
  protocolName: string,
  feeBps: number,
  changedAt: string = new Date().toISOString(),
): void {
  if (!protocolName || !Number.isFinite(feeBps)) return;

  const existing = feeHistory.get(protocolName) ?? [];
  const last = existing[existing.length - 1];
  if (last && last.feeBps === feeBps) {
    return; // No change — nothing to record.
  }

  const next = [...existing, { feeBps, changedAt }].slice(-MAX_FEE_HISTORY_ENTRIES);
  feeHistory.set(protocolName, next);
}

/**
 * Returns the fee history for a protocol, newest-first. Returns an empty
 * array (never null/undefined) when nothing has been recorded yet, so
 * callers can render a stable empty state without extra null-checks.
 */
export function getFeeHistory(protocolName: string): ProtocolFeeSnapshot[] {
  const entries = feeHistory.get(protocolName) ?? [];
  return [...entries].reverse();
}

/** Test/utility hook: clears all recorded history. */
export function resetFeeHistory(): void {
  feeHistory.clear();
}
