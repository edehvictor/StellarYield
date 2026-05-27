import type {
  AlertEvent,
  Cluster,
  NotificationEvent,
  RankedCluster,
  RecommendationEvent,
} from './types';

/**
 * Clamps a number to the closed interval [0, 100].
 */
function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Computes an importance score in [0, 100] for a single notification event.
 *
 * - AlertEvent:          clamp(|currentValue - thresholdValue| / thresholdValue * 100, 0, 100)
 *                        If thresholdValue is 0, score is 0.
 * - RecommendationEvent: HOLD/DEFER → MIGRATE = 80; MIGRATE → HOLD/DEFER = 30; other = 50
 * - WatchlistEvent:      clamp((1 - vaultHealthScore) * 100, 0, 100)
 *                        vaultHealthScore defaults to 0.5 when not provided (score = 50).
 *
 * @param event            - The notification event to score.
 * @param vaultHealthScore - Optional vault health score (0–1) for WatchlistEvents.
 * @returns A number in [0, 100].
 */
export function computeImportanceScore(
  event: NotificationEvent,
  vaultHealthScore?: number,
): number {
  switch (event.eventType) {
    case 'alert': {
      const e = event as AlertEvent;
      if (e.thresholdValue === 0) return 0;
      return clamp(
        (Math.abs(e.currentValue - e.thresholdValue) / Math.abs(e.thresholdValue)) * 100,
      );
    }

    case 'recommendation': {
      const e = event as RecommendationEvent;
      const from = e.previousDecision;
      const to = e.newDecision;
      if ((from === 'HOLD' || from === 'DEFER') && to === 'MIGRATE') return 80;
      if (from === 'MIGRATE' && (to === 'HOLD' || to === 'DEFER')) return 30;
      return 50;
    }

    case 'watchlist': {
      const health = vaultHealthScore ?? 0.5;
      return clamp((1 - health) * 100);
    }
  }
}

/**
 * Ranks an array of deduplicated clusters by importance.
 *
 * For each cluster:
 * - Computes the importance score for every event (passing vaultHealthScore
 *   from WatchlistEvents where available).
 * - Sets `topImportanceScore` to the maximum score across all events.
 *
 * Clusters are sorted descending by `topImportanceScore`; ties are broken by
 * the most recent `triggeredAt` timestamp across all events in the cluster
 * (most recent first).
 *
 * @param clusters - Deduplicated clusters to rank.
 * @returns RankedCluster[] sorted highest-importance first.
 */
export function rankClusters(clusters: Cluster[]): RankedCluster[] {
  const ranked: RankedCluster[] = clusters.map((cluster) => {
    let topImportanceScore = 0;

    for (const event of cluster.events) {
      // vaultHealthScore is not stored on the event; callers may pass it
      // explicitly. Within rankClusters we default to undefined (→ 0.5 inside
      // computeImportanceScore) since no external health score is available.
      const score = computeImportanceScore(event);
      if (score > topImportanceScore) {
        topImportanceScore = score;
      }
    }

    return {
      ...cluster,
      topImportanceScore,
      summary: '', // DigestFormatter fills this in
    };
  });

  ranked.sort((a, b) => {
    if (b.topImportanceScore !== a.topImportanceScore) {
      return b.topImportanceScore - a.topImportanceScore;
    }
    // Tiebreaker: most recent triggeredAt across all events in the cluster
    const latestA = mostRecentTriggeredAt(a.events);
    const latestB = mostRecentTriggeredAt(b.events);
    return latestB - latestA;
  });

  return ranked;
}

/**
 * Returns the latest `triggeredAt` timestamp (ms) across all events in the array.
 * Falls back to 0 if the array is empty or timestamps are missing.
 */
function mostRecentTriggeredAt(events: NotificationEvent[]): number {
  let latest = 0;
  for (const event of events) {
    const ts = new Date(event.triggeredAt).getTime();
    if (!isNaN(ts) && ts > latest) latest = ts;
  }
  return latest;
}
