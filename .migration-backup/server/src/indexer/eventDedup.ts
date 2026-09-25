/**
 * Contract event deduplication for repeated ledger ingestion (#1361).
 *
 * The Soroban RPC event cursor is inclusive: after committing ledger N the
 * indexer's next poll requests `startLedger = N`, so boundary events are
 * re-delivered on every poll. A crash between event processing and the
 * checkpoint write re-delivers whole ledger ranges. Without a dedup layer,
 * every re-delivery re-runs decode + upsert work and can multiply dead-letter
 * rows for permanently bad events.
 *
 * This module gives ingestion a deterministic identity per event plus a
 * TTL-bounded in-memory tracker, so re-delivered events are recognized and
 * skipped before they reach the database — no schema change required.
 *
 * Key format (mirrors `event_dedup_key` in contracts/yield_vault/src/events.rs):
 *   `${contractId}:${ledger}:${txHash}:${topic}:${data}`
 */

/** The fields that uniquely identify one contract event delivery. */
export interface DedupableEventParts {
  contractId: string;
  ledger: number;
  txHash: string;
  /** Raw topic (e.g. joined topic XDR) as delivered by the RPC. */
  topic: string;
  /** Raw event data (e.g. value XDR) as delivered by the RPC. */
  data: string;
}

/**
 * Deterministic identity string for one event delivery. Byte-identical
 * inputs always produce the same key; any difference in ledger, transaction,
 * topic, or payload produces a different key.
 */
export function computeEventDedupKey(event: DedupableEventParts): string {
  return `${event.contractId}:${event.ledger}:${event.txHash}:${event.topic}:${event.data}`;
}

export interface EventDedupTrackerOptions {
  /** How long a recorded key suppresses re-deliveries. Default: 15 minutes. */
  windowMs?: number;
  /** Maximum keys retained (evicts oldest-first). Default: 10,000. */
  maxEntries?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

export interface EventDedupStats {
  /** Keys currently retained in the window. */
  trackedKeys: number;
  /** Re-deliveries suppressed since construction/reset. */
  duplicatesSkipped: number;
  /** First-time events recorded since construction/reset. */
  uniqueSeen: number;
  /** Effective suppression window in milliseconds. */
  windowMs: number;
}

/**
 * TTL-bounded dedup tracker for ledger event ingestion.
 *
 * `checkAndRecord` is the primary API: it reports whether the key was already
 * seen inside the suppression window, and records first-time keys. Duplicate
 * hits do not refresh the original timestamp, so a key expires a fixed
 * `windowMs` after its first sighting.
 */
export class EventDedupTracker {
  private readonly seen = new Map<string, number>();
  private duplicatesSkipped = 0;
  private uniqueSeen = 0;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: EventDedupTrackerOptions = {}) {
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Check whether `key` was already recorded inside the window and record it
   * when it is new. Returns `true` when the delivery is a duplicate that
   * should be skipped.
   */
  checkAndRecord(key: string): boolean {
    const at = this.now();
    this.prune(at);

    const firstSeenAt = this.seen.get(key);
    if (firstSeenAt !== undefined && at - firstSeenAt < this.windowMs) {
      this.duplicatesSkipped += 1;
      return true;
    }

    this.seen.set(key, at);
    this.uniqueSeen += 1;
    return false;
  }

  /** Snapshot of current counters. */
  stats(): EventDedupStats {
    return {
      trackedKeys: this.seen.size,
      duplicatesSkipped: this.duplicatesSkipped,
      uniqueSeen: this.uniqueSeen,
      windowMs: this.windowMs,
    };
  }

  /** Clear all tracked keys and counters (used by tests and operator resets). */
  reset(): void {
    this.seen.clear();
    this.duplicatesSkipped = 0;
    this.uniqueSeen = 0;
  }

  private prune(now: number): void {
    for (const [key, recordedAt] of this.seen) {
      if (now - recordedAt >= this.windowMs) {
        this.seen.delete(key);
      } else {
        // Insertion order matches recording order for new keys, so the
        // remaining entries are all still inside the window.
        break;
      }
    }

    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done === true) break;
      this.seen.delete(oldest.value);
    }
  }
}

/**
 * In-batch dedup helper: keeps the first occurrence of each key, preserving
 * input order, and reports the duplicates that were dropped.
 */
export function dedupeBatch<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): { unique: T[]; duplicateKeys: string[] } {
  const seen = new Set<string>();
  const unique: T[] = [];
  const duplicateKeys: string[] = [];

  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      duplicateKeys.push(key);
    } else {
      seen.add(key);
      unique.push(item);
    }
  }

  return { unique, duplicateKeys };
}

/** Process-wide tracker used by the live indexer poll loop. */
export const eventDedupTracker = new EventDedupTracker();

/** Reset the process-wide tracker (tests / operator maintenance). */
export function resetEventDedupTracker(): void {
  eventDedupTracker.reset();
}
