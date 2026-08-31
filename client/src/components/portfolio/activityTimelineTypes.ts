export type AccountActivityEventType =
  | "deposit"
  | "withdrawal"
  | "reward"
  | "recommendation"
  | "alert"
  | "rebalance";

export type TransactionStatus = "completed" | "pending" | "failed";

export interface AccountActivityFilters {
  types?: AccountActivityEventType[];
  protocol?: string;
  asset?: string;
  status?: TransactionStatus;
}

export type AccountActivitySource =
  | "portfolio"
  | "rewards"
  | "advisor"
  | "monitoring"
  | "automation";

export interface AccountActivityEvent {
  id: string;
  walletAddress: string;
  type: AccountActivityEventType;
  title: string;
  description: string;
  timestamp: string;
  source: AccountActivitySource;
  amountUsd?: number;
  assetSymbol?: string;
  protocol?: string;
  status?: TransactionStatus;
  severity?: "info" | "warning" | "critical";
  relatedVaultId?: string;
  metadata?: Record<string, string | number | boolean | null>;
  /**
   * Ledger sequence number from the Stellar network. When present, ordering
   * prefers this over the wall-clock timestamp (#1009).
   */
  ledger?: number;
  /**
   * Transaction hash for exact-match deduplication across sources (#1009).
   * Two events with the same `txHash` are considered equivalent regardless
   * of which source emitted them.
   */
  txHash?: string;
  /**
   * Source priority used as the final tiebreaker when ledger and timestamp
   * are identical. Lower numbers sort earlier (higher priority) (#1009).
   */
  sourcePriority?: number;
}

// ── Ordering & deduplication helpers (#1009) ─────────────────────────────────

/**
 * Human-readable labels for each activity source.
 * Displayed as a badge on merged/multi-source activity items.
 */
export const SOURCE_LABELS: Record<AccountActivitySource, string> = {
  portfolio:  "Portfolio",
  rewards:    "Rewards",
  advisor:    "Advisor",
  monitoring: "Monitoring",
  automation: "Automation",
};

/**
 * Default source priority order.  Lower value = higher priority when two
 * events share the same ledger / timestamp and differ only in source.
 */
export const DEFAULT_SOURCE_PRIORITY: Record<AccountActivitySource, number> = {
  portfolio:  1,
  rewards:    2,
  advisor:    3,
  monitoring: 4,
  automation: 5,
};

/**
 * Resolve the effective sort key for an event.  The ordering contract is:
 *   1. ledger (ascending, lower ledger = older)
 *   2. timestamp (ascending, older first)
 *   3. sourcePriority (ascending, lower = higher priority)
 *
 * The timeline is ultimately rendered newest-first so the caller should
 * reverse the ascending result.
 */
export function getEventSortKey(event: AccountActivityEvent): {
  ledger: number;
  timestampMs: number;
  sourcePriority: number;
} {
  return {
    ledger: event.ledger ?? Number.MAX_SAFE_INTEGER,
    timestampMs: new Date(event.timestamp).getTime(),
    sourcePriority:
      event.sourcePriority ??
      DEFAULT_SOURCE_PRIORITY[event.source] ??
      Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Compare two events for ascending chronological order.
 * Returns a negative number if `a` comes before `b`, positive if after,
 * zero if indistinguishable.
 */
export function compareEventsAscending(
  a: AccountActivityEvent,
  b: AccountActivityEvent,
): number {
  const ka = getEventSortKey(a);
  const kb = getEventSortKey(b);

  if (ka.ledger !== kb.ledger) return ka.ledger - kb.ledger;
  if (ka.timestampMs !== kb.timestampMs) return ka.timestampMs - kb.timestampMs;
  return ka.sourcePriority - kb.sourcePriority;
}

/**
 * Deduplicate an array of activity events.
 *
 * Two events are considered duplicates when:
 *  - They share the same `txHash` (non-empty), OR
 *  - They share the same `id`
 *
 * When duplicates are found the event with the highest-priority source
 * (lowest `sourcePriority` value) is kept.  If priorities are equal the
 * first occurrence in the input array wins.
 */
export function deduplicateEvents(
  events: AccountActivityEvent[],
): AccountActivityEvent[] {
  const byId = new Map<string, AccountActivityEvent>();
  const byTxHash = new Map<string, AccountActivityEvent>();

  for (const event of events) {
    // Dedup by txHash first
    if (event.txHash) {
      const existing = byTxHash.get(event.txHash);
      if (existing) {
        const existingPriority =
          existing.sourcePriority ?? DEFAULT_SOURCE_PRIORITY[existing.source] ?? Number.MAX_SAFE_INTEGER;
        const newPriority =
          event.sourcePriority ?? DEFAULT_SOURCE_PRIORITY[event.source] ?? Number.MAX_SAFE_INTEGER;
        if (newPriority < existingPriority) {
          byTxHash.set(event.txHash, event);
          // Also update the id map if the old entry was registered there
          if (byId.get(existing.id) === existing) {
            byId.delete(existing.id);
            byId.set(event.id, event);
          }
        }
        continue;
      }
      byTxHash.set(event.txHash, event);
    }

    // Dedup by id
    if (!byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }

  // Collect unique events respecting txHash wins
  const seen = new Set<AccountActivityEvent>();
  const result: AccountActivityEvent[] = [];

  for (const event of byTxHash.values()) {
    seen.add(event);
    result.push(event);
  }
  for (const event of byId.values()) {
    if (!seen.has(event) && !event.txHash) {
      result.push(event);
    }
  }

  return result;
}

/**
 * Sort and deduplicate a mixed-source activity event array.
 * Returns events ordered newest-first (descending by ledger → timestamp →
 * source priority) with duplicates removed.
 */
export function sortAndDeduplicateTimeline(
  events: AccountActivityEvent[],
): AccountActivityEvent[] {
  const deduped = deduplicateEvents(events);
  return deduped.sort((a, b) => compareEventsAscending(b, a)); // descending
}

/**
 * Apply filters to an array of activity events.
 * Returns events matching all provided filter criteria.
 */
export function filterActivityEvents(
  events: AccountActivityEvent[],
  filters: AccountActivityFilters,
): AccountActivityEvent[] {
  return events.filter((event) => {
    if (filters.types && filters.types.length > 0) {
      if (!filters.types.includes(event.type)) return false;
    }
    if (filters.protocol && event.protocol !== filters.protocol) return false;
    if (filters.asset && event.assetSymbol !== filters.asset) return false;
    if (filters.status && event.status !== filters.status) return false;
    return true;
  });
}
