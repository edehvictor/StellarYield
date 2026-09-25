import type {
  AlertEvent,
  Cluster,
  NotificationEvent,
  RecommendationEvent,
  WatchlistEvent,
} from './types';

/**
 * Returns the deduplication key for an event within its cluster.
 * - alert:       (condition, vaultId)
 * - recommendation: (sourceStrategyId, destinationStrategyId)
 * - watchlist:   (vaultId, conditionDescription)
 */
function getDedupKey(event: NotificationEvent): string {
  switch (event.eventType) {
    case 'alert': {
      const e = event as AlertEvent;
      return `${e.condition}|${e.vaultId}`;
    }
    case 'recommendation': {
      const e = event as RecommendationEvent;
      return `${e.sourceStrategyId}|${e.destinationStrategyId}`;
    }
    case 'watchlist': {
      const e = event as WatchlistEvent;
      return `${e.vaultId}|${e.conditionDescription}`;
    }
  }
}

/**
 * Deduplicates events within a cluster by retaining only the most recent
 * event per deduplication key.
 *
 * - Alert clusters:          one event per (condition, vaultId)
 * - Recommendation clusters: one event per (sourceStrategyId, destinationStrategyId)
 * - Watchlist clusters:      one event per (vaultId, conditionDescription)
 *
 * Events that differ in their key fields are always preserved.
 * Output event count is always <= input event count.
 *
 * @param cluster - The input cluster (not mutated).
 * @returns A new Cluster with deduplicated events.
 */
export function deduplicateCluster(cluster: Cluster): Cluster {
  const latest = new Map<string, NotificationEvent>();

  for (const event of cluster.events) {
    const key = getDedupKey(event);
    const existing = latest.get(key);

    if (
      existing === undefined ||
      new Date(event.triggeredAt).getTime() >
        new Date(existing.triggeredAt).getTime()
    ) {
      latest.set(key, event);
    }
  }

  return {
    eventType: cluster.eventType,
    clusterKey: cluster.clusterKey,
    events: Array.from(latest.values()),
  };
}
