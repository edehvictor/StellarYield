/**
 * Unit tests for DigestGenerationJob (BullMQ workers)
 * Requirements: 5.6, 5.7
 */

import {
  createDigestGenerationWorker,
  createDigestThresholdCheckWorker,
  type DigestGenerationJobData,
  type DigestThresholdCheckJobData,
} from '../jobs/digestSchedulerJob';
import type { DigestPayload, ScheduleConfig } from '../services/digest/types';

// ─── Minimal mock helpers ─────────────────────────────────────────────────────

function makePayload(clusters: DigestPayload['clusters'] = []): DigestPayload {
  return {
    walletAddress: '0xWallet',
    generatedAt: new Date().toISOString(),
    scheduleMode: 'daily',
    clusters,
  };
}

function makeJob<T>(data: T) {
  return { data } as import('bullmq').Job<T>;
}

// ─── Mock Redis ───────────────────────────────────────────────────────────────

function makeMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    rpush: jest.fn().mockResolvedValue(1),
    zcard: jest.fn().mockResolvedValue(0),
    hget: jest.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as import('ioredis').Redis;
}

// ─── Mock DigestBuilder ───────────────────────────────────────────────────────

function makeMockDigestBuilder(payload: DigestPayload) {
  return {
    buildDigest: jest.fn().mockResolvedValue(payload),
  } as unknown as import('../services/digest/DigestBuilder').DigestBuilder;
}

// ─── Mock DigestDeliveryService ───────────────────────────────────────────────

function makeMockDeliveryService(result = { ok: true as const }) {
  return {
    deliver: jest.fn().mockResolvedValue(result),
  } as unknown as import('../services/digest/DigestDeliveryService').DigestDeliveryService;
}

// ─── Mock Queue ───────────────────────────────────────────────────────────────

function makeMockQueue() {
  return {
    add: jest.fn().mockResolvedValue({}),
  } as unknown as import('bullmq').Queue;
}

// ─── Extract the processor function from a Worker ─────────────────────────────
// BullMQ Worker constructor: new Worker(queueName, processor, opts)
// We capture the processor by intercepting the constructor.

jest.mock('bullmq', () => {
  const actual = jest.requireActual<typeof import('bullmq')>('bullmq');
  return {
    ...actual,
    Worker: jest.fn().mockImplementation((_name: string, processor: unknown) => ({
      _processor: processor,
      close: jest.fn(),
    })),
  };
});

// Helper to extract the processor from a mocked Worker instance
function getProcessor<T>(worker: unknown): (job: import('bullmq').Job<T>) => Promise<void> {
  return (worker as { _processor: (job: import('bullmq').Job<T>) => Promise<void> })._processor;
}

// ─── DigestGenerationWorker tests ─────────────────────────────────────────────

describe('createDigestGenerationWorker', () => {
  test('skips delivery and does not write audit log when clusters is empty', async () => {
    const redis = makeMockRedis();
    const emptyPayload = makePayload([]);
    const builder = makeMockDigestBuilder(emptyPayload);
    const delivery = makeMockDeliveryService();

    const worker = createDigestGenerationWorker(redis, builder, delivery);
    const processor = getProcessor<DigestGenerationJobData>(worker);

    const jobData: DigestGenerationJobData = {
      walletAddress: '0xWallet',
      scheduleMode: 'daily',
      triggeredAt: new Date().toISOString(),
    };

    await processor(makeJob(jobData));

    expect(builder.buildDigest).toHaveBeenCalledWith('0xWallet', 'daily');
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(redis.rpush).not.toHaveBeenCalled();
  });

  test('calls deliver and writes audit log when clusters is non-empty', async () => {
    const redis = makeMockRedis();
    const cluster: DigestPayload['clusters'][0] = {
      eventType: 'alert',
      topImportanceScore: 50,
      eventCount: 1,
      summary: 'test',
    };
    const payload = makePayload([cluster]);
    const builder = makeMockDigestBuilder(payload);
    const delivery = makeMockDeliveryService();

    const worker = createDigestGenerationWorker(redis, builder, delivery);
    const processor = getProcessor<DigestGenerationJobData>(worker);

    const jobData: DigestGenerationJobData = {
      walletAddress: '0xWallet',
      scheduleMode: 'daily',
      triggeredAt: new Date().toISOString(),
    };

    await processor(makeJob(jobData));

    expect(delivery.deliver).toHaveBeenCalledWith(payload);
    expect(redis.rpush).toHaveBeenCalledWith(
      'digest:audit:0xWallet',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  test('audit log entry is an ISO 8601 timestamp', async () => {
    const redis = makeMockRedis();
    const cluster: DigestPayload['clusters'][0] = {
      eventType: 'watchlist',
      topImportanceScore: 30,
      eventCount: 2,
      summary: 'watchlist summary',
    };
    const payload = makePayload([cluster]);
    const builder = makeMockDigestBuilder(payload);
    const delivery = makeMockDeliveryService();

    const worker = createDigestGenerationWorker(redis, builder, delivery);
    const processor = getProcessor<DigestGenerationJobData>(worker);

    await processor(makeJob({ walletAddress: '0xABC', scheduleMode: 'weekly', triggeredAt: new Date().toISOString() }));

    const [, timestamp] = (redis.rpush as jest.Mock).mock.calls[0] as [string, string];
    expect(() => new Date(timestamp)).not.toThrow();
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });
});

// ─── DigestThresholdCheckWorker tests ─────────────────────────────────────────

describe('createDigestThresholdCheckWorker', () => {
  test('does not enqueue generation job when event count is below threshold', async () => {
    const config: ScheduleConfig = {
      walletAddress: '0xWallet',
      mode: 'event_threshold',
      eventThreshold: 10,
      updatedAt: new Date().toISOString(),
    };
    const redis = makeMockRedis({
      zcard: jest.fn().mockResolvedValue(5),
      hget: jest.fn().mockResolvedValue(JSON.stringify(config)),
    });
    const builder = makeMockDigestBuilder(makePayload());
    const queue = makeMockQueue();

    const worker = createDigestThresholdCheckWorker(redis, builder, queue);
    const processor = getProcessor<DigestThresholdCheckJobData>(worker);

    await processor(makeJob({ walletAddress: '0xWallet', scheduleMode: 'event_threshold' }));

    expect(queue.add).not.toHaveBeenCalled();
  });

  test('enqueues generation job when event count meets threshold', async () => {
    const config: ScheduleConfig = {
      walletAddress: '0xWallet',
      mode: 'event_threshold',
      eventThreshold: 5,
      updatedAt: new Date().toISOString(),
    };
    const redis = makeMockRedis({
      zcard: jest.fn().mockResolvedValue(5),
      hget: jest.fn().mockResolvedValue(JSON.stringify(config)),
    });
    const builder = makeMockDigestBuilder(makePayload());
    const queue = makeMockQueue();

    const worker = createDigestThresholdCheckWorker(redis, builder, queue);
    const processor = getProcessor<DigestThresholdCheckJobData>(worker);

    await processor(makeJob({ walletAddress: '0xWallet', scheduleMode: 'event_threshold' }));

    expect(queue.add).toHaveBeenCalledWith(
      'digest-0xWallet',
      expect.objectContaining({
        walletAddress: '0xWallet',
        scheduleMode: 'event_threshold',
        triggeredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
  });

  test('enqueues generation job when event count exceeds threshold', async () => {
    const config: ScheduleConfig = {
      walletAddress: '0xWallet',
      mode: 'event_threshold',
      eventThreshold: 3,
      updatedAt: new Date().toISOString(),
    };
    const redis = makeMockRedis({
      zcard: jest.fn().mockResolvedValue(10),
      hget: jest.fn().mockResolvedValue(JSON.stringify(config)),
    });
    const builder = makeMockDigestBuilder(makePayload());
    const queue = makeMockQueue();

    const worker = createDigestThresholdCheckWorker(redis, builder, queue);
    const processor = getProcessor<DigestThresholdCheckJobData>(worker);

    await processor(makeJob({ walletAddress: '0xWallet', scheduleMode: 'event_threshold' }));

    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  test('skips gracefully when schedule config is malformed JSON', async () => {
    const redis = makeMockRedis({
      zcard: jest.fn().mockResolvedValue(20),
      hget: jest.fn().mockResolvedValue('not-valid-json{{{'),
    });
    const builder = makeMockDigestBuilder(makePayload());
    const queue = makeMockQueue();

    const worker = createDigestThresholdCheckWorker(redis, builder, queue);
    const processor = getProcessor<DigestThresholdCheckJobData>(worker);

    await processor(makeJob({ walletAddress: '0xWallet', scheduleMode: 'event_threshold' }));

    expect(queue.add).not.toHaveBeenCalled();
  });

  test('skips gracefully when no schedule config exists in Redis', async () => {
    const redis = makeMockRedis({
      zcard: jest.fn().mockResolvedValue(20),
      hget: jest.fn().mockResolvedValue(null),
    });
    const builder = makeMockDigestBuilder(makePayload());
    const queue = makeMockQueue();

    const worker = createDigestThresholdCheckWorker(redis, builder, queue);
    const processor = getProcessor<DigestThresholdCheckJobData>(worker);

    await processor(makeJob({ walletAddress: '0xWallet', scheduleMode: 'event_threshold' }));

    expect(queue.add).not.toHaveBeenCalled();
  });

  test('skips gracefully when schedule config has no eventThreshold', async () => {
    const config: ScheduleConfig = {
      walletAddress: '0xWallet',
      mode: 'daily',
      updatedAt: new Date().toISOString(),
    };
    const redis = makeMockRedis({
      zcard: jest.fn().mockResolvedValue(20),
      hget: jest.fn().mockResolvedValue(JSON.stringify(config)),
    });
    const builder = makeMockDigestBuilder(makePayload());
    const queue = makeMockQueue();

    const worker = createDigestThresholdCheckWorker(redis, builder, queue);
    const processor = getProcessor<DigestThresholdCheckJobData>(worker);

    await processor(makeJob({ walletAddress: '0xWallet', scheduleMode: 'event_threshold' }));

    expect(queue.add).not.toHaveBeenCalled();
  });
});
