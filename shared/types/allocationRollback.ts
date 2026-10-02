/**
 * Deterministic vault allocation rollback preview types (#1360).
 *
 * Shared between the server (preview builder + route) and the client panel so
 * both sides agree on the exact preview contract. A preview is read-only:
 * producing one never mutates queue state or allocations.
 */

/** Where the preview's input allocations came from. */
export type AllocationRollbackSource =
  /** Caller supplied the allocation maps explicitly (POST body). */
  | "explicit"
  /** Derived from the vault's latest pending rebalance queue entry (GET). */
  | "pending-rebalance";

/** A single per-vault weight difference between current and rollback state. */
export interface AllocationRollbackChange {
  vaultId: string;
  /** Weight after the (pending) rebalance, i.e. the state to roll back from. */
  currentWeight: number;
  /** Weight the rollback would restore. */
  rollbackWeight: number;
  /** rollbackWeight - currentWeight (fixed 4-decimal rounding). */
  deltaWeight: number;
}

/**
 * Byte-stable, read-only preview of a vault allocation rollback.
 *
 * Determinism contract: identical inputs always produce an identical preview —
 * the same key ordering, the same fixed-point rounding, and the same
 * `inputHash`. No wall-clock timestamps or random values are embedded.
 */
export interface AllocationRollbackPreview {
  vaultId: string;
  source: AllocationRollbackSource;
  /** Canonical (sorted, rounded) weights to roll back from. */
  currentAllocations: Record<string, number>;
  /** Canonical (sorted, rounded) weights the rollback would restore. */
  rollbackAllocations: Record<string, number>;
  /** One row per allocation key, sorted ascending by `vaultId`. */
  changes: AllocationRollbackChange[];
  /** Sum of all `deltaWeight` values (rounded). */
  totalDeltaWeight: number;
  /** True when every delta is zero — rollback would be a no-op. */
  noOp: boolean;
  /** Ids of other active queue entries that conflict with this rollback. */
  conflictingQueueEntryIds: string[];
  /** False when any conflicting queue entry exists. */
  safe: boolean;
  rollbackReason?: string;
  /** SHA-256 over the canonical inputs — identical inputs ⇒ identical hash. */
  inputHash: string;
}
