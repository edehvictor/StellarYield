import type { Redis } from 'ioredis';
import { clusterEvents } from './EventClusterer';
import { deduplicateCluster } from './Deduplicator';
import { rankClusters } from './EventRanker';
import { formatDigest } from './DigestFormatter';
import type {
  DigestPayload,
  IngestResult,
  NotificationEvent,
  ScheduleMode,
} from './types';

const EVENTS_KEY = (walletAddress: string) =>
  `digest:events:${walletAddress}`;

export class DigestBuilder {
  constructor(private redis: Redis) {}

  /**
   * Validates and persists a raw notification event to Redis.
   *
   * - Rejects events with a missing or empty walletAddress.
   * - Generates a UUID v4 eventId and sets recordedAt to the current time.
   * - Stores the event in a sorted set keyed by walletAddress, scored by
   *   triggeredAt in milliseconds.
   */
  async ingestEvent(
    event: Omit<NotificationEvent, 'eventId' | 'recordedAt'>,
  ): Promise<IngestResult> {
    if (!event.walletAddress || event.walletAddress.trim() === '') {
      return { ok: false, error: 'INVALID_EVENT' };
    }

    const eventId = crypto.randomUUID();
    const recordedAt = new Date().toISOString();

    const fullEvent: NotificationEvent = {
      ...(event as NotificationEvent),
      eventId,
      recordedAt,
    };

    const score = new Date(event.triggeredAt).getTime();
    const key = EVENTS_KEY(event.walletAddress);

    await this.redis.zadd(key, score, JSON.stringify(fullEvent));

    return { ok: true, eventId };
  }

  /**
   * Builds a DigestPayload for the given walletAddress by running the full
   * pipeline: fetch → filter → cluster → deduplicate → rank → format.
   *
   * @param walletAddress - The user whose events to process.
   * @param scheduleMode  - The schedule mode to embed in the payload.
   * @param windowMs      - Optional clustering window in ms (default 24 h).
   */
  async buildDigest(
    walletAddress: string,
    scheduleMode: ScheduleMode,
    windowMs?: number,
  ): Promise<DigestPayload> {
    const key = EVENTS_KEY(walletAddress);

    // Fetch all members with their scores from the sorted set.
    const raw = await this.redis.zrange(key, 0, -1);

    // Parse and strictly filter by walletAddress (user-scope isolation).
    const events: NotificationEvent[] = raw
      .map((json) => {
        try {
          return JSON.parse(json) as NotificationEvent;
        } catch {
          return null;
        }
      })
      .filter(
        (e): e is NotificationEvent =>
          e !== null && e.walletAddress === walletAddress,
      );

    if (events.length === 0) {
      return {
        walletAddress,
        generatedAt: new Date().toISOString(),
        scheduleMode,
        clusters: [],
      };
    }

    // Run the pipeline.
    const clusters = clusterEvents(events, windowMs);
    const deduplicated = clusters.map(deduplicateCluster);
    const ranked = rankClusters(deduplicated);
    return formatDigest(walletAddress, scheduleMode, ranked);
  }

  /**
   * Deletes all persisted events for the given walletAddress.
   * Called after successful digest delivery.
   */
  async clearEvents(walletAddress: string): Promise<void> {
    await this.redis.del(EVENTS_KEY(walletAddress));
  }
}
