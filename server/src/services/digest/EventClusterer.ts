import type { NotificationEvent, Cluster } from './types';

const MAX_WINDOW_MS = 86_400_000; // 24 hours

/**
 * Derives the cluster key for a given event.
 * - alert / watchlist  → vaultId
 * - recommendation     → sourceStrategyId:destinationStrategyId
 */
function getClusterKey(event: NotificationEvent): string {
  if (event.eventType === 'recommendation') {
    return `${event.sourceStrategyId}:${event.destinationStrategyId}`;
  }
  return event.vaultId;
}

/**
 * Groups notification events into Clusters by (eventType, clusterKey).
 *
 * @param events   - Raw notification events (may be from multiple users).
 * @param windowMs - Time window in ms (capped at 24 h). Events older than
 *                   (maxTriggeredAt − windowMs) are excluded.
 *                   Defaults to 86 400 000 ms (24 hours).
 * @returns One Cluster per distinct (eventType, clusterKey) pair.
 */
export function clusterEvents(
  events: NotificationEvent[],
  windowMs: number = MAX_WINDOW_MS,
): Cluster[] {
  if (events.length === 0) {
    return [];
  }

  // Cap the window at 24 hours.
  const effectiveWindow = Math.min(windowMs, MAX_WINDOW_MS);

  // Find the most recent triggeredAt across all events.
  const maxTriggeredAt = events.reduce((max, e) => {
    const t = new Date(e.triggeredAt).getTime();
    return t > max ? t : max;
  }, -Infinity);

  const cutoff = maxTriggeredAt - effectiveWindow;

  // Filter events outside the window.
  const inWindow = events.filter(
    (e) => new Date(e.triggeredAt).getTime() > cutoff,
  );

  // Group by composite key "{eventType}|{clusterKey}".
  const map = new Map<string, Cluster>();

  for (const event of inWindow) {
    const clusterKey = getClusterKey(event);
    const compositeKey = `${event.eventType}|${clusterKey}`;

    if (!map.has(compositeKey)) {
      map.set(compositeKey, {
        eventType: event.eventType,
        clusterKey,
        events: [],
      });
    }

    map.get(compositeKey)!.events.push(event);
  }

  return Array.from(map.values());
}
