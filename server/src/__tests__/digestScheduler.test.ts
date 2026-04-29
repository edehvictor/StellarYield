/**
 * Unit tests for DigestScheduler
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { DigestScheduler } from '../services/digest/DigestScheduler';
import type { ScheduleConfig } from '../services/digest/types';

// ─── Mock BullMQ Queue ────────────────────────────────────────────────────────

jest.mock('bullmq', () => {
  const actual = jest.requireActual<typeof import('bullmq')>('bullmq');
  return {
    ...actual,
    Queue: jest.fn().mockImplementation(() => ({
      add: jest.fn().mockResolvedValue({}),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

// ─── Mock Redis ───────────────────────────────────────────────────────────────

function makeMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    hset: jest.fn().mockResolvedValue(1),
    hget: jest.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as import('ioredis').Redis;
}

function makeMockQueue(repeatableJobs: unknown[] = []) {
  return {
    add: jest.fn().mockResolvedValue({}),
    getRepeatableJobs: jest.fn().mockResolvedValue(repeatableJobs),
    removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('bullmq').Queue;
}

// ─── configure() tests ────────────────────────────────────────────────────────

describe('DigestScheduler.configure', () => {
  test('returns { ok: true } for daily mode', async () => {
    const redis = makeMockRedis();
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    const result = await scheduler.configure('0xWallet', { mode: 'daily' });

    expect(result).toEqual({ ok: true });
  });

  test('returns { ok: true } for weekly mode', async () => {
    const redis = makeMockRedis();
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    const result = await scheduler.configure('0xWallet', { mode: 'weekly' });

    expect(result).toEqual({ ok: true });
  });

  test('returns { ok: true } for event_threshold mode with valid threshold', async () => {
    const redis = makeMockRedis();
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    const result = await scheduler.configure('0xWallet', {
      mode: 'event_threshold',
      eventThreshold: 10,
    });

    expect(result).toEqual({ ok: true });
  });

  test('returns { ok: false, error: "INVALID_THRESHOLD" } when threshold is 0', async () => {
    const redis = makeMockRedis();
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    const result = await scheduler.configure('0xWallet', {
      mode: 'event_threshold',
      eventThreshold: 0,
    });

    expect(result).toEqual({ ok: false, error: 'INVALID_THRESHOLD' });
  });

  test('returns { ok: false, error: "INVALID_THRESHOLD" } when threshold is 101', async () => {
    const redis = makeMockRedis();
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    const result = await scheduler.configure('0xWallet', {
      mode: 'event_threshold',
      eventThreshold: 101,
    });

    expect(result).toEqual({ ok: false, error: 'INVALID_THRESHOLD' });
  });

  test('returns { ok: false, error: "INVALID_THRESHOLD" } when threshold is undefined for event_threshold mode', async () => {
    const redis = makeMockRedis();
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    const result = await scheduler.configure('0xWallet', {
      mode: 'event_threshold',
      eventThreshold: undefined,
    });

    expect(result).toEqual({ ok: false, error: 'INVALID_THRESHOLD' });
  });

  test('persists config to Redis on success', async () => {
    const redis = makeMockRedis();
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    await scheduler.configure('0xWallet', { mode: 'daily' });

    expect(redis.hset).toHaveBeenCalledWith(
      'digest:schedule:0xWallet',
      'data',
      expect.stringContaining('"walletAddress":"0xWallet"'),
    );
  });

  test('removes existing repeatable jobs before adding new one', async () => {
    const existingJob = { name: 'digest-0xWallet', key: 'some-key' };
    const queue = makeMockQueue([existingJob]);
    const redis = makeMockRedis();
    const scheduler = new DigestScheduler(redis, queue);

    await scheduler.configure('0xWallet', { mode: 'daily' });

    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('some-key');
  });

  test('adds a repeatable job for daily mode', async () => {
    const redis = makeMockRedis();
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    await scheduler.configure('0xWallet', { mode: 'daily' });

    expect(queue.add).toHaveBeenCalledWith(
      'digest-0xWallet',
      expect.objectContaining({ walletAddress: '0xWallet', scheduleMode: 'daily' }),
      expect.objectContaining({ repeat: { every: 86_400_000 } }),
    );
  });

  test('adds a repeatable job for weekly mode', async () => {
    const redis = makeMockRedis();
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    await scheduler.configure('0xWallet', { mode: 'weekly' });

    expect(queue.add).toHaveBeenCalledWith(
      'digest-0xWallet',
      expect.objectContaining({ walletAddress: '0xWallet', scheduleMode: 'weekly' }),
      expect.objectContaining({ repeat: { every: 604_800_000 } }),
    );
  });

  test('boundary: threshold of 1 is valid', async () => {
    const redis = makeMockRedis();
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    const result = await scheduler.configure('0xWallet', {
      mode: 'event_threshold',
      eventThreshold: 1,
    });

    expect(result).toEqual({ ok: true });
  });

  test('boundary: threshold of 100 is valid', async () => {
    const redis = makeMockRedis();
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    const result = await scheduler.configure('0xWallet', {
      mode: 'event_threshold',
      eventThreshold: 100,
    });

    expect(result).toEqual({ ok: true });
  });
});

// ─── getConfig() tests ────────────────────────────────────────────────────────

describe('DigestScheduler.getConfig', () => {
  test('returns null when no config exists', async () => {
    const redis = makeMockRedis({ hget: jest.fn().mockResolvedValue(null) });
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    const result = await scheduler.getConfig('0xWallet');

    expect(result).toBeNull();
  });

  test('returns parsed ScheduleConfig when config exists', async () => {
    const config: ScheduleConfig = {
      walletAddress: '0xWallet',
      mode: 'daily',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const redis = makeMockRedis({
      hget: jest.fn().mockResolvedValue(JSON.stringify(config)),
    });
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    const result = await scheduler.getConfig('0xWallet');

    expect(result).toEqual(config);
  });

  test('returns null when stored data is invalid JSON', async () => {
    const redis = makeMockRedis({
      hget: jest.fn().mockResolvedValue('not-valid-json{{{'),
    });
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    const result = await scheduler.getConfig('0xWallet');

    expect(result).toBeNull();
  });

  test('reads from the correct Redis key', async () => {
    const redis = makeMockRedis({ hget: jest.fn().mockResolvedValue(null) });
    const queue = makeMockQueue();
    const scheduler = new DigestScheduler(redis, queue);

    await scheduler.getConfig('0xSpecificWallet');

    expect(redis.hget).toHaveBeenCalledWith('digest:schedule:0xSpecificWallet', 'data');
  });
});
