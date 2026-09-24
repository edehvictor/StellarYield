/**
 * Property-based tests for the Adaptive Notification Digest pure pipeline.
 *
 * Feature: adaptive-notification-digest
 *
 * These tests verify universal correctness properties from the design document
 * across arbitrary inputs using fast-check (requirement 9.2–9.5):
 *
 *   P3  Cluster count equals distinct (type, clusterKey) pairs
 *   P4  Clustering preserves total event count
 *   P5  Deduplication never increases event count
 *   P6  Deduplication retains only the most recent duplicate
 *   P7  Distinct events are never removed by deduplication
 *   P8  Importance scores are always in [0, 100]
 *   P9  Digest payload importance scores are non-increasing
 *   P12 DigestPayload JSON round-trip
 *   P13 Summary strings contain all interpolated values
 */

import fc from 'fast-check';
import { clusterEvents } from '../services/digest/EventClusterer';
import { deduplicateCluster } from '../services/digest/Deduplicator';
import { computeImportanceScore, rankClusters } from '../services/digest/EventRanker';
import { formatSummary, formatDigest } from '../services/digest/DigestFormatter';
import type {
  AlertEvent,
  Cluster,
  NotificationEvent,
  RecommendationEvent,
  WatchlistEvent,
} from '../services/digest/types';

// ─── Arbitraries ───────────────────────────────────────────────────────────────

const CLUSTER_WINDOW_MS = 86_400_000; // 24 hours
const BASE_TIME = Date.now();

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** Timestamps guaranteed to fall inside any 24 h clustering window. */
const recentTimestampArb = fc
  .integer({ min: BASE_TIME - CLUSTER_WINDOW_MS / 2, max: BASE_TIME })
  .map(isoFromMs);

const walletAddressArb = fc.string({ minLength: 1, maxLength: 20 });

const alertEventArb = fc.record({
  eventId: fc.string(),
  eventType: fc.constant('alert' as const),
  walletAddress: walletAddressArb,
  vaultId: fc.string(),
  condition: fc.string(),
  thresholdValue: fc.float({ min: 1, max: 1000 }),
  currentValue: fc.float({ min: 0, max: 2000 }),
  triggeredAt: recentTimestampArb,
  recordedAt: recentTimestampArb,
});

const recommendationEventArb = fc.record({
  eventId: fc.string(),
  eventType: fc.constant('recommendation' as const),
  walletAddress: walletAddressArb,
  sourceStrategyId: fc.string(),
  destinationStrategyId: fc.string(),
  previousDecision: fc.constantFrom('MIGRATE', 'HOLD', 'DEFER'),
  newDecision: fc.constantFrom('MIGRATE', 'HOLD', 'DEFER'),
  recordedAt: recentTimestampArb,
  triggeredAt: recentTimestampArb,
});

const watchlistEventArb = fc.record({
  eventId: fc.string(),
  eventType: fc.constant('watchlist' as const),
  walletAddress: walletAddressArb,
  vaultId: fc.string(),
  trigger: fc.constantFrom(
    'apy_change',
    'risk_change',
    'freshness_change',
    'alert_triggered',
  ),
  severity: fc.constantFrom('info', 'warning', 'critical'),
  conditionDescription: fc.string(),
  previousValue: fc.option(fc.float({ min: 0, max: 1000 }), { nil: null }),
  currentValue: fc.option(fc.float({ min: 0, max: 1000 }), { nil: null }),
  triggeredAt: recentTimestampArb,
  recordedAt: recentTimestampArb,
});

const notificationEventArb = fc.oneof<
  AlertEvent | RecommendationEvent | WatchlistEvent
>(alertEventArb as never, recommendationEventArb as never, watchlistEventArb as never);

// ─── Expectation helpers ──────────────────────────────────────────────────────

/** Mirrors the implementation's cluster key derivation. */
function clusterKeyOf(event: NotificationEvent): string {
  if (event.eventType === 'recommendation') {
    return `${event.sourceStrategyId}:${event.destinationStrategyId}`;
  }
  return event.vaultId;
}

/** Mirrors the implementation's per-event deduplication key. */
function dedupKeyOf(event: NotificationEvent): string {
  switch (event.eventType) {
    case 'alert':
      return `${event.condition}|${event.vaultId}`;
    case 'recommendation':
      return `${event.sourceStrategyId}|${event.destinationStrategyId}`;
    case 'watchlist':
      return `${event.vaultId}|${event.conditionDescription}`;
  }
}

function triggeredMs(event: NotificationEvent): number {
  return new Date(event.triggeredAt).getTime();
}

// ─── Properties ───────────────────────────────────────────────────────────────

describe('Digest pipeline — property tests (fast-check)', () => {
  describe('Property 3: cluster count equals distinct (type, clusterKey) pairs', () => {
    it('holds for any non-empty event set', () => {
      fc.assert(
        fc.property(
          fc.array(notificationEventArb, { minLength: 1, maxLength: 30 }),
          (events) => {
            const expected = new Set(
              events.map((e) => `${e.eventType}|${clusterKeyOf(e)}`),
            ).size;
            expect(clusterEvents(events, CLUSTER_WINDOW_MS)).toHaveLength(expected);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Property 4: clustering preserves total event count', () => {
    it('holds for any event set', () => {
      fc.assert(
        fc.property(
          fc.array(notificationEventArb, { maxLength: 30 }),
          (events) => {
            const clusters = clusterEvents(events, CLUSTER_WINDOW_MS);
            const outputCount = clusters.reduce(
              (sum, c) => sum + c.events.length,
              0,
            );
            expect(outputCount).toBe(events.length);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Property 5: deduplication never increases event count', () => {
    it('holds for any cluster', () => {
      fc.assert(
        fc.property(
          fc.array(notificationEventArb, { minLength: 1, maxLength: 30 }),
          (events) => {
            const cluster: Cluster = {
              eventType: events[0].eventType,
              clusterKey: clusterKeyOf(events[0]),
              events,
            };
            expect(deduplicateCluster(cluster).events.length).toBeLessThanOrEqual(
              events.length,
            );
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Property 6: deduplication retains only the most recent duplicate', () => {
    it('holds for any cluster', () => {
      fc.assert(
        fc.property(
          fc.array(notificationEventArb, { minLength: 1, maxLength: 30 }),
          (events) => {
            const cluster: Cluster = {
              eventType: events[0].eventType,
              clusterKey: clusterKeyOf(events[0]),
              events,
            };
            const result = deduplicateCluster(cluster);

            const latestByKey = new Map<string, NotificationEvent>();
            for (const event of events) {
              const key = dedupKeyOf(event);
              const existing = latestByKey.get(key);
              if (existing === undefined || triggeredMs(event) > triggeredMs(existing)) {
                latestByKey.set(key, event);
              }
            }

            expect(result.events).toHaveLength(latestByKey.size);
            for (const kept of result.events) {
              const expected = latestByKey.get(dedupKeyOf(kept));
              expect(kept.eventId).toBe(expected!.eventId);
              expect(triggeredMs(kept)).toBe(triggeredMs(expected!));
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Property 7: distinct events are never removed by deduplication', () => {
    it('holds for event sets with unique deduplication keys', () => {
      fc.assert(
        fc.property(
          fc.set(fc.string(), { minLength: 2, maxLength: 5 }).chain((vaultIds) =>
            fc.array(
              fc.record({
                eventId: fc.string(),
                eventType: fc.constant('alert' as const),
                walletAddress: walletAddressArb,
                vaultId: fc.constantFrom(...vaultIds),
                condition: fc.string(),
                thresholdValue: fc.float({ min: 1, max: 1000 }),
                currentValue: fc.float({ min: 0, max: 2000 }),
                triggeredAt: recentTimestampArb,
                recordedAt: recentTimestampArb,
              }),
              { minLength: 1, maxLength: 20 },
            ),
          ),
          (events) => {
            const distinctVaultIds = new Set(events.map((e) => e.vaultId));
            if (distinctVaultIds.size !== events.length) {
              // Property only applies when every event is distinct in its key.
              return;
            }
            const cluster: Cluster = {
              eventType: 'alert',
              clusterKey: 'mixed',
              events,
            };
            expect(deduplicateCluster(cluster).events.length).toBe(events.length);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Property 8: importance scores are always in [0, 100]', () => {
    it('holds for any notification event', () => {
      fc.assert(
        fc.property(notificationEventArb, (event) => {
          const score = computeImportanceScore(event);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(100);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Property 9: digest payload importance scores are non-increasing', () => {
    it('holds for any event set', () => {
      fc.assert(
        fc.property(
          fc.array(notificationEventArb, { minLength: 1, maxLength: 30 }),
          (events) => {
            const wallet = events[0].walletAddress;
            const clusters = clusterEvents(events, CLUSTER_WINDOW_MS);
            const ranked = rankClusters(clusters.map(deduplicateCluster));
            const payload = formatDigest(wallet, 'daily', ranked);

            for (let i = 1; i < payload.clusters.length; i++) {
              expect(payload.clusters[i - 1].topImportanceScore).toBeGreaterThanOrEqual(
                payload.clusters[i].topImportanceScore,
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Property 12: DigestPayload JSON round-trip', () => {
    it('produces a deeply equal object after stringify + parse', () => {
      fc.assert(
        fc.property(
          fc.array(notificationEventArb, { minLength: 1, maxLength: 10 }),
          (events) => {
            const wallet = events[0].walletAddress;
            const clusters = clusterEvents(events, CLUSTER_WINDOW_MS);
            const ranked = rankClusters(clusters.map(deduplicateCluster));
            const payload = formatDigest(wallet, 'event_threshold', ranked);
            const roundTripped = JSON.parse(JSON.stringify(payload));
            expect(roundTripped).toEqual(payload);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Property 13: summary strings contain all interpolated values', () => {
    it('alert summaries contain condition, thresholdValue, and vaultId', () => {
      fc.assert(
        fc.property(
          fc.record({
            eventId: fc.string(),
            eventType: fc.constant('alert' as const),
            walletAddress: walletAddressArb,
            vaultId: fc.string({ minLength: 1 }),
            condition: fc.string({ minLength: 1 }),
            thresholdValue: fc.float({ min: 1, max: 1000 }),
            currentValue: fc.float({ min: 0, max: 2000 }),
            triggeredAt: recentTimestampArb,
            recordedAt: recentTimestampArb,
          }),
          (event: AlertEvent) => {
            const summary = formatSummary(event);
            expect(summary).toContain(event.condition);
            expect(summary).toContain(String(event.thresholdValue));
            expect(summary).toContain(event.vaultId);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('recommendation summaries contain both decisions and strategy ids', () => {
      fc.assert(
        fc.property(
          fc.record({
            eventId: fc.string(),
            eventType: fc.constant('recommendation' as const),
            walletAddress: walletAddressArb,
            sourceStrategyId: fc.string({ minLength: 1 }),
            destinationStrategyId: fc.string({ minLength: 1 }),
            previousDecision: fc.constantFrom('MIGRATE', 'HOLD', 'DEFER'),
            newDecision: fc.constantFrom('MIGRATE', 'HOLD', 'DEFER'),
            recordedAt: recentTimestampArb,
            triggeredAt: recentTimestampArb,
          }),
          (event: RecommendationEvent) => {
            const summary = formatSummary(event);
            expect(summary).toContain(event.previousDecision);
            expect(summary).toContain(event.newDecision);
            expect(summary).toContain(event.sourceStrategyId);
            expect(summary).toContain(event.destinationStrategyId);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('watchlist summaries contain the vaultId and the condition when applicable', () => {
      fc.assert(
        fc.property(
          fc.record({
            eventId: fc.string(),
            eventType: fc.constant('watchlist' as const),
            walletAddress: walletAddressArb,
            vaultId: fc.string({ minLength: 1 }),
            trigger: fc.constantFrom(
              'apy_change',
              'risk_change',
              'freshness_change',
              'alert_triggered',
              'custom',
            ),
            severity: fc.constantFrom('info', 'warning', 'critical'),
            conditionDescription: fc.string({ minLength: 1 }),
            previousValue: fc.option(fc.float({ min: 0, max: 1000 }), { nil: null }),
            currentValue: fc.option(fc.float({ min: 0, max: 1000 }), { nil: null }),
            triggeredAt: recentTimestampArb,
            recordedAt: recentTimestampArb,
          }),
          (raw) => {
            const event = raw as unknown as WatchlistEvent;
            const summary = formatSummary(event);
            expect(summary).toContain(event.vaultId);
            if (raw.trigger === 'custom') {
              expect(summary).toContain(event.conditionDescription);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});