import { clusterEvents } from '../services/digest/EventClusterer';
import { deduplicateCluster } from '../services/digest/Deduplicator';
import { computeImportanceScore, rankClusters } from '../services/digest/EventRanker';
import { formatSummary, formatDigest } from '../services/digest/DigestFormatter';
import type {
  AlertEvent,
  RecommendationEvent,
  WatchlistEvent,
  NotificationEvent,
  Cluster,
  RankedCluster,
} from '../services/digest/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAlert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    eventId: 'a1',
    eventType: 'alert',
    walletAddress: '0xWallet',
    vaultId: 'vault-1',
    condition: 'APY_DROP',
    thresholdValue: 100,
    currentValue: 80,
    triggeredAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<RecommendationEvent> = {}): RecommendationEvent {
  return {
    eventId: 'r1',
    eventType: 'recommendation',
    walletAddress: '0xWallet',
    sourceStrategyId: 'strat-A',
    destinationStrategyId: 'strat-B',
    previousDecision: 'HOLD',
    newDecision: 'MIGRATE',
    triggeredAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeWatchlist(overrides: Partial<WatchlistEvent> = {}): WatchlistEvent {
  return {
    eventId: 'w1',
    eventType: 'watchlist',
    walletAddress: '0xWallet',
    vaultId: 'vault-1',
    conditionDescription: 'TVL below threshold',
    triggeredAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── EventClusterer ───────────────────────────────────────────────────────────

describe('EventClusterer', () => {
  test('empty input returns empty array', () => {
    expect(clusterEvents([])).toEqual([]);
  });

  test('events with same (eventType, vaultId) are grouped into one cluster', () => {
    const now = new Date().toISOString();
    const events: NotificationEvent[] = [
      makeAlert({ eventId: 'a1', vaultId: 'vault-1', triggeredAt: now }),
      makeAlert({ eventId: 'a2', vaultId: 'vault-1', triggeredAt: now }),
    ];
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].events).toHaveLength(2);
  });

  test('events with different vaultIds produce separate clusters', () => {
    const now = new Date().toISOString();
    const events: NotificationEvent[] = [
      makeAlert({ eventId: 'a1', vaultId: 'vault-1', triggeredAt: now }),
      makeAlert({ eventId: 'a2', vaultId: 'vault-2', triggeredAt: now }),
    ];
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(2);
  });

  test('recommendation events cluster by sourceStrategyId:destinationStrategyId', () => {
    const now = new Date().toISOString();
    const events: NotificationEvent[] = [
      makeRecommendation({ eventId: 'r1', sourceStrategyId: 'A', destinationStrategyId: 'B', triggeredAt: now }),
      makeRecommendation({ eventId: 'r2', sourceStrategyId: 'A', destinationStrategyId: 'B', triggeredAt: now }),
      makeRecommendation({ eventId: 'r3', sourceStrategyId: 'A', destinationStrategyId: 'C', triggeredAt: now }),
    ];
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(2);
    const abCluster = clusters.find(c => c.clusterKey === 'A:B');
    expect(abCluster?.events).toHaveLength(2);
  });

  test('events outside the windowMs are filtered out', () => {
    const now = Date.now();
    const recent = new Date(now).toISOString();
    const old = new Date(now - 10_000).toISOString(); // 10 seconds ago
    const events: NotificationEvent[] = [
      makeAlert({ eventId: 'a1', vaultId: 'vault-1', triggeredAt: recent }),
      makeAlert({ eventId: 'a2', vaultId: 'vault-1', triggeredAt: old }),
    ];
    // windowMs of 5 seconds — old event is outside
    const clusters = clusterEvents(events, 5_000);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].events).toHaveLength(1);
    expect(clusters[0].events[0].eventId).toBe('a1');
  });

  test('cluster count equals distinct (eventType, clusterKey) pairs', () => {
    const now = new Date().toISOString();
    const events: NotificationEvent[] = [
      makeAlert({ eventId: 'a1', vaultId: 'vault-1', triggeredAt: now }),
      makeAlert({ eventId: 'a2', vaultId: 'vault-2', triggeredAt: now }),
      makeWatchlist({ eventId: 'w1', vaultId: 'vault-1', triggeredAt: now }),
      makeRecommendation({ eventId: 'r1', sourceStrategyId: 'A', destinationStrategyId: 'B', triggeredAt: now }),
    ];
    // 4 distinct (eventType, clusterKey) pairs
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(4);
  });
});

// ─── Deduplicator ─────────────────────────────────────────────────────────────

describe('Deduplicator', () => {
  test('duplicate alert events (same condition+vaultId) → only most recent kept', () => {
    const older = makeAlert({ eventId: 'a1', triggeredAt: '2024-01-01T10:00:00Z' });
    const newer = makeAlert({ eventId: 'a2', triggeredAt: '2024-01-01T11:00:00Z' });
    const cluster: Cluster = { eventType: 'alert', clusterKey: 'vault-1', events: [older, newer] };
    const result = deduplicateCluster(cluster);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventId).toBe('a2');
  });

  test('duplicate recommendation events (same strategy pair) → only most recent kept', () => {
    const older = makeRecommendation({ eventId: 'r1', triggeredAt: '2024-01-01T10:00:00Z' });
    const newer = makeRecommendation({ eventId: 'r2', triggeredAt: '2024-01-01T12:00:00Z' });
    const cluster: Cluster = { eventType: 'recommendation', clusterKey: 'strat-A:strat-B', events: [older, newer] };
    const result = deduplicateCluster(cluster);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventId).toBe('r2');
  });

  test('duplicate watchlist events (same vaultId+conditionDescription) → only most recent kept', () => {
    const older = makeWatchlist({ eventId: 'w1', triggeredAt: '2024-01-01T08:00:00Z' });
    const newer = makeWatchlist({ eventId: 'w2', triggeredAt: '2024-01-01T09:00:00Z' });
    const cluster: Cluster = { eventType: 'watchlist', clusterKey: 'vault-1', events: [older, newer] };
    const result = deduplicateCluster(cluster);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventId).toBe('w2');
  });

  test('events with distinct keys are all preserved', () => {
    const a1 = makeAlert({ eventId: 'a1', vaultId: 'vault-1', condition: 'APY_DROP' });
    const a2 = makeAlert({ eventId: 'a2', vaultId: 'vault-2', condition: 'APY_DROP' });
    const a3 = makeAlert({ eventId: 'a3', vaultId: 'vault-1', condition: 'TVL_DROP' });
    const cluster: Cluster = { eventType: 'alert', clusterKey: 'mixed', events: [a1, a2, a3] };
    const result = deduplicateCluster(cluster);
    expect(result.events).toHaveLength(3);
  });

  test('output count is always <= input count', () => {
    const events = [
      makeAlert({ eventId: 'a1', triggeredAt: '2024-01-01T10:00:00Z' }),
      makeAlert({ eventId: 'a2', triggeredAt: '2024-01-01T11:00:00Z' }),
      makeAlert({ eventId: 'a3', triggeredAt: '2024-01-01T12:00:00Z' }),
    ];
    const cluster: Cluster = { eventType: 'alert', clusterKey: 'vault-1', events: events };
    const result = deduplicateCluster(cluster);
    expect(result.events.length).toBeLessThanOrEqual(events.length);
  });
});

// ─── EventRanker ──────────────────────────────────────────────────────────────

describe('EventRanker', () => {
  test('computeImportanceScore for alert returns value in [0, 100]', () => {
    const event = makeAlert({ thresholdValue: 100, currentValue: 80 });
    const score = computeImportanceScore(event);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  test('HOLD→MIGRATE scores 80', () => {
    const event = makeRecommendation({ previousDecision: 'HOLD', newDecision: 'MIGRATE' });
    expect(computeImportanceScore(event)).toBe(80);
  });

  test('MIGRATE→HOLD scores 30', () => {
    const event = makeRecommendation({ previousDecision: 'MIGRATE', newDecision: 'HOLD' });
    expect(computeImportanceScore(event)).toBe(30);
  });

  test('rankClusters returns clusters sorted by topImportanceScore descending', () => {
    const now = new Date().toISOString();
    const lowCluster: Cluster = {
      eventType: 'recommendation',
      clusterKey: 'A:B',
      events: [makeRecommendation({ previousDecision: 'MIGRATE', newDecision: 'HOLD', triggeredAt: now })],
    };
    const highCluster: Cluster = {
      eventType: 'recommendation',
      clusterKey: 'C:D',
      events: [makeRecommendation({ sourceStrategyId: 'C', destinationStrategyId: 'D', previousDecision: 'HOLD', newDecision: 'MIGRATE', triggeredAt: now })],
    };
    const ranked = rankClusters([lowCluster, highCluster]);
    expect(ranked[0].topImportanceScore).toBeGreaterThanOrEqual(ranked[1].topImportanceScore);
    expect(ranked[0].topImportanceScore).toBe(80);
    expect(ranked[1].topImportanceScore).toBe(30);
  });

  test('DEFER→MIGRATE scores 80', () => {
    const event = makeRecommendation({ previousDecision: 'DEFER', newDecision: 'MIGRATE' });
    expect(computeImportanceScore(event)).toBe(80);
  });

  test('MIGRATE→DEFER scores 30', () => {
    const event = makeRecommendation({ previousDecision: 'MIGRATE', newDecision: 'DEFER' });
    expect(computeImportanceScore(event)).toBe(30);
  });

  test('HOLD→HOLD scores 50 (other transition)', () => {
    const event = makeRecommendation({ previousDecision: 'HOLD', newDecision: 'HOLD' });
    expect(computeImportanceScore(event)).toBe(50);
  });

  test('watchlist with explicit vaultHealthScore=0 scores 100', () => {
    const event = makeWatchlist();
    expect(computeImportanceScore(event, 0)).toBe(100);
  });

  test('watchlist with explicit vaultHealthScore=1 scores 0', () => {
    const event = makeWatchlist();
    expect(computeImportanceScore(event, 1)).toBe(0);
  });

  test('tiebreaker: equal scores sorted by most recent triggeredAt', () => {
    const olderCluster: Cluster = {
      eventType: 'recommendation',
      clusterKey: 'A:B',
      events: [makeRecommendation({ previousDecision: 'HOLD', newDecision: 'MIGRATE', triggeredAt: '2024-01-01T10:00:00Z' })],
    };
    const newerCluster: Cluster = {
      eventType: 'recommendation',
      clusterKey: 'C:D',
      events: [makeRecommendation({ sourceStrategyId: 'C', destinationStrategyId: 'D', previousDecision: 'HOLD', newDecision: 'MIGRATE', triggeredAt: '2024-01-01T12:00:00Z' })],
    };
    const ranked = rankClusters([olderCluster, newerCluster]);
    // Both score 80; newer triggeredAt should come first
    expect(ranked[0].clusterKey).toBe('C:D');
    expect(ranked[1].clusterKey).toBe('A:B');
  });
});

// ─── DigestFormatter ──────────────────────────────────────────────────────────

describe('DigestFormatter', () => {
  test('formatSummary for AlertEvent matches exact format', () => {
    const event = makeAlert({ condition: 'APY_DROP', thresholdValue: 5, vaultId: 'vault-42' });
    expect(formatSummary(event)).toBe('APY_DROP threshold of 5 triggered for vault vault-42');
  });

  test('formatSummary for RecommendationEvent matches exact format', () => {
    const event = makeRecommendation({
      previousDecision: 'HOLD',
      newDecision: 'MIGRATE',
      sourceStrategyId: 'strat-A',
      destinationStrategyId: 'strat-B',
    });
    expect(formatSummary(event)).toBe(
      'Recommendation changed from HOLD to MIGRATE for strategy strat-A → strat-B',
    );
  });

  test('formatSummary for WatchlistEvent matches exact format', () => {
    const event = makeWatchlist({ conditionDescription: 'TVL below threshold', vaultId: 'vault-7' });
    expect(formatSummary(event)).toBe("Watchlist condition 'TVL below threshold' met for vault vault-7");
  });

  test('formatDigest returns DigestPayload with correct walletAddress, scheduleMode, clusters', () => {
    const now = new Date().toISOString();
    const rankedCluster: RankedCluster = {
      eventType: 'alert',
      clusterKey: 'vault-1',
      events: [makeAlert({ vaultId: 'vault-1', triggeredAt: now })],
      topImportanceScore: 20,
      summary: '',
    };
    const payload = formatDigest('0xABC', 'daily', [rankedCluster]);
    expect(payload.walletAddress).toBe('0xABC');
    expect(payload.scheduleMode).toBe('daily');
    expect(payload.clusters).toHaveLength(1);
    expect(payload.clusters[0].eventType).toBe('alert');
    expect(payload.clusters[0].topImportanceScore).toBe(20);
    expect(payload.clusters[0].eventCount).toBe(1);
  });

  test('formatDigest picks the most recent event as top event for summary', () => {
    const older = makeAlert({ eventId: 'a1', vaultId: 'vault-1', triggeredAt: '2024-01-01T10:00:00Z', condition: 'APY_DROP', thresholdValue: 5 });
    const newer = makeAlert({ eventId: 'a2', vaultId: 'vault-1', triggeredAt: '2024-01-01T12:00:00Z', condition: 'TVL_DROP', thresholdValue: 10 });
    const rankedCluster: RankedCluster = {
      eventType: 'alert',
      clusterKey: 'vault-1',
      events: [older, newer],
      topImportanceScore: 20,
      summary: '',
    };
    const payload = formatDigest('0xABC', 'daily', [rankedCluster]);
    // Summary should be from the newer event (TVL_DROP)
    expect(payload.clusters[0].summary).toContain('TVL_DROP');
  });

  test('formatDigest includes vaultId on entry when cluster has vaultId', () => {
    const now = new Date().toISOString();
    const rankedCluster: RankedCluster = {
      eventType: 'alert',
      clusterKey: 'vault-99',
      vaultId: 'vault-99',
      events: [makeAlert({ vaultId: 'vault-99', triggeredAt: now })],
      topImportanceScore: 20,
      summary: '',
    };
    const payload = formatDigest('0xABC', 'daily', [rankedCluster]);
    expect(payload.clusters[0].vaultId).toBe('vault-99');
  });

  test('JSON round-trip: JSON.parse(JSON.stringify(payload)) deep-equals payload', () => {
    const now = new Date().toISOString();
    const rankedCluster: RankedCluster = {
      eventType: 'recommendation',
      clusterKey: 'strat-A:strat-B',
      events: [makeRecommendation({ triggeredAt: now })],
      topImportanceScore: 80,
      summary: '',
    };
    const payload = formatDigest('0xDEF', 'weekly', [rankedCluster]);
    const roundTripped = JSON.parse(JSON.stringify(payload));
    expect(roundTripped).toEqual(payload);
  });
});
