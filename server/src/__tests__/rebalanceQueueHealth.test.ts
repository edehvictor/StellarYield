import {
  summarizeQueueHealth,
  type QueueEntrySnapshot,
} from '../services/rebalanceQueueService';
import { EXECUTION_TYPE, REBALANCE_STATUS } from '../queues/types';

// Mock Prisma — rebalanceQueueService.ts instantiates a PrismaClient at
// module load time, so any test importing it needs this mock even when
// only exercising the pure summarizeQueueHealth() function.
jest.mock('@prisma/client', () => {
  const instance = {
    rebalanceQueueEntry: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    rebalanceHistory: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const MockPrismaClient = jest.fn(() => instance);
  return { PrismaClient: MockPrismaClient };
});

const NOW = new Date('2026-06-30T12:00:00.000Z');

function entry(overrides: Partial<QueueEntrySnapshot> = {}): QueueEntrySnapshot {
  return {
    status: REBALANCE_STATUS.PENDING,
    executionType: EXECUTION_TYPE.FULL,
    attemptCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    deferredUntil: null,
    ...overrides,
  };
}

describe('summarizeQueueHealth', () => {
  it('returns all-zero counts for an empty queue snapshot', () => {
    const result = summarizeQueueHealth([], NOW);
    expect(result).toEqual({
      active: 0,
      waiting: 0,
      delayed: 0,
      retrying: 0,
      failed: 0,
      deadLettered: 0,
      total: 0,
      generatedAt: NOW.toISOString(),
    });
  });

  it('classifies a fresh, never-attempted pending entry as waiting', () => {
    const result = summarizeQueueHealth([entry({ attemptCount: 0, nextRetryAt: null })], NOW);
    expect(result.waiting).toBe(1);
    expect(result.retrying).toBe(0);
    expect(result.delayed).toBe(0);
  });

  it('classifies a processing entry as active', () => {
    const result = summarizeQueueHealth([entry({ status: REBALANCE_STATUS.PROCESSING })], NOW);
    expect(result.active).toBe(1);
  });

  it('classifies a pending entry with a future nextRetryAt as delayed, not retrying', () => {
    const future = new Date(NOW.getTime() + 60_000);
    const result = summarizeQueueHealth(
      [entry({ attemptCount: 1, nextRetryAt: future })],
      NOW,
    );
    expect(result.delayed).toBe(1);
    expect(result.retrying).toBe(0);
  });

  it('classifies a pending entry with a past-due nextRetryAt and prior attempts as retrying', () => {
    const past = new Date(NOW.getTime() - 60_000);
    const result = summarizeQueueHealth(
      [entry({ attemptCount: 1, nextRetryAt: past })],
      NOW,
    );
    expect(result.retrying).toBe(1);
    expect(result.delayed).toBe(0);
    expect(result.waiting).toBe(0);
  });

  it('classifies a pending entry with nextRetryAt exactly now as retrying (boundary is inclusive of "due")', () => {
    const result = summarizeQueueHealth(
      [entry({ attemptCount: 1, nextRetryAt: new Date(NOW.getTime()) })],
      NOW,
    );
    expect(result.retrying).toBe(1);
    expect(result.delayed).toBe(0);
  });

  it('classifies a deferred entry with a future deferredUntil as delayed', () => {
    const future = new Date(NOW.getTime() + 60_000);
    const result = summarizeQueueHealth(
      [
        entry({
          executionType: EXECUTION_TYPE.DEFERRED,
          deferredUntil: future,
          attemptCount: 0,
        }),
      ],
      NOW,
    );
    expect(result.delayed).toBe(1);
    expect(result.waiting).toBe(0);
  });

  it('classifies a deferred entry with a past-due deferredUntil and no attempts as waiting', () => {
    const past = new Date(NOW.getTime() - 60_000);
    const result = summarizeQueueHealth(
      [
        entry({
          executionType: EXECUTION_TYPE.DEFERRED,
          deferredUntil: past,
          attemptCount: 0,
        }),
      ],
      NOW,
    );
    expect(result.waiting).toBe(1);
    expect(result.delayed).toBe(0);
  });

  it('classifies a failed entry with retries remaining as failed, not dead-lettered', () => {
    // e.g. intent expired before retries were exhausted
    const result = summarizeQueueHealth(
      [entry({ status: REBALANCE_STATUS.FAILED, attemptCount: 1, maxRetries: 3 })],
      NOW,
    );
    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(0);
  });

  it('classifies a failed entry that exhausted its retries as dead-lettered', () => {
    const result = summarizeQueueHealth(
      [entry({ status: REBALANCE_STATUS.FAILED, attemptCount: 4, maxRetries: 3 })],
      NOW,
    );
    expect(result.deadLettered).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('treats attemptCount exactly equal to maxRetries as dead-lettered (boundary)', () => {
    const result = summarizeQueueHealth(
      [entry({ status: REBALANCE_STATUS.FAILED, attemptCount: 3, maxRetries: 3 })],
      NOW,
    );
    expect(result.deadLettered).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('ignores completed, partial, and cancelled entries entirely', () => {
    const result = summarizeQueueHealth(
      [
        entry({ status: REBALANCE_STATUS.COMPLETED }),
        entry({ status: REBALANCE_STATUS.PARTIAL }),
        entry({ status: REBALANCE_STATUS.CANCELLED }),
      ],
      NOW,
    );
    expect(result.total).toBe(0);
    expect(result.active).toBe(0);
    expect(result.waiting).toBe(0);
  });

  it('summarizes a mixed-state snapshot across every bucket at once', () => {
    const future = new Date(NOW.getTime() + 60_000);
    const past = new Date(NOW.getTime() - 60_000);

    const result = summarizeQueueHealth(
      [
        entry({ attemptCount: 0, nextRetryAt: null }), // waiting
        entry({ status: REBALANCE_STATUS.PROCESSING }), // active
        entry({ attemptCount: 1, nextRetryAt: future }), // delayed
        entry({ attemptCount: 2, nextRetryAt: past }), // retrying
        entry({ status: REBALANCE_STATUS.FAILED, attemptCount: 1, maxRetries: 3 }), // failed
        entry({ status: REBALANCE_STATUS.FAILED, attemptCount: 3, maxRetries: 3 }), // deadLettered
        entry({ status: REBALANCE_STATUS.COMPLETED }), // ignored
      ],
      NOW,
    );

    expect(result).toEqual({
      active: 1,
      waiting: 1,
      delayed: 1,
      retrying: 1,
      failed: 1,
      deadLettered: 1,
      total: 6,
      generatedAt: NOW.toISOString(),
    });
  });

  it('handles an overloaded queue snapshot (large counts across every bucket)', () => {
    const past = new Date(NOW.getTime() - 60_000);
    const future = new Date(NOW.getTime() + 60_000);

    const entries: QueueEntrySnapshot[] = [
      ...Array.from({ length: 500 }, () => entry({ attemptCount: 0 })), // waiting
      ...Array.from({ length: 50 }, () => entry({ status: REBALANCE_STATUS.PROCESSING })), // active
      ...Array.from({ length: 200 }, () => entry({ attemptCount: 1, nextRetryAt: future })), // delayed
      ...Array.from({ length: 150 }, () => entry({ attemptCount: 1, nextRetryAt: past })), // retrying
      ...Array.from({ length: 75 }, () =>
        entry({ status: REBALANCE_STATUS.FAILED, attemptCount: 1, maxRetries: 3 }),
      ), // failed
      ...Array.from({ length: 25 }, () =>
        entry({ status: REBALANCE_STATUS.FAILED, attemptCount: 3, maxRetries: 3 }),
      ), // deadLettered
    ];

    const result = summarizeQueueHealth(entries, NOW);

    expect(result.waiting).toBe(500);
    expect(result.active).toBe(50);
    expect(result.delayed).toBe(200);
    expect(result.retrying).toBe(150);
    expect(result.failed).toBe(75);
    expect(result.deadLettered).toBe(25);
    expect(result.total).toBe(1000);
  });

  it('defaults `now` to the current time when omitted', () => {
    const result = summarizeQueueHealth([entry()]);
    expect(result.waiting).toBe(1);
    expect(typeof result.generatedAt).toBe('string');
  });
});