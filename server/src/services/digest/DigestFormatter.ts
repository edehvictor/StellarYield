import type {
  AlertEvent,
  DigestPayload,
  NotificationEvent,
  RankedCluster,
  RankedClusterEntry,
  RecommendationEvent,
  ScheduleMode,
  WatchlistEvent,
} from './types';

/**
 * Produces a human-readable summary string for a single notification event.
 *
 * - AlertEvent:          "[condition] threshold of [thresholdValue] triggered for vault [vaultId]"
 * - RecommendationEvent: "Recommendation changed from [previousDecision] to [newDecision] for strategy [sourceStrategyId] → [destinationStrategyId]"
 * - WatchlistEvent:      "Watchlist condition '[conditionDescription]' met for vault [vaultId]"
 */
export function formatSummary(event: NotificationEvent): string {
  switch (event.eventType) {
    case 'alert': {
      const e = event as AlertEvent;
      return `${e.condition} threshold of ${e.thresholdValue} triggered for vault ${e.vaultId}`;
    }
    case 'recommendation': {
      const e = event as RecommendationEvent;
      return `Recommendation changed from ${e.previousDecision} to ${e.newDecision} for strategy ${e.sourceStrategyId} → ${e.destinationStrategyId}`;
    }
    case 'watchlist': {
      const e = event as WatchlistEvent;
      return `Watchlist condition '${e.conditionDescription}' met for vault ${e.vaultId}`;
    }
  }
}

/**
 * Selects the top event (highest triggeredAt) from a cluster's event list.
 * Falls back to the first event if timestamps are missing or unparseable.
 */
function topEvent(events: NotificationEvent[]): NotificationEvent {
  let best = events[0];
  let bestTs = new Date(best.triggeredAt).getTime();

  for (let i = 1; i < events.length; i++) {
    const ts = new Date(events[i].triggeredAt).getTime();
    if (!isNaN(ts) && (isNaN(bestTs) || ts > bestTs)) {
      best = events[i];
      bestTs = ts;
    }
  }

  return best;
}

/**
 * Converts an array of RankedCluster objects into a DigestPayload.
 *
 * For each cluster the summary is derived from the top event (highest triggeredAt).
 * The vaultId field is included on the entry when present on the cluster.
 */
export function formatDigest(
  walletAddress: string,
  scheduleMode: ScheduleMode,
  rankedClusters: RankedCluster[],
): DigestPayload {
  const clusters: RankedClusterEntry[] = rankedClusters.map((cluster) => {
    const top = topEvent(cluster.events);
    const summary = formatSummary(top);

    const entry: RankedClusterEntry = {
      eventType: cluster.eventType,
      topImportanceScore: cluster.topImportanceScore,
      eventCount: cluster.events.length,
      summary,
    };

    if (cluster.vaultId !== undefined) {
      entry.vaultId = cluster.vaultId;
    }

    return entry;
  });

  return {
    walletAddress,
    generatedAt: new Date().toISOString(),
    scheduleMode,
    clusters,
  };
}
