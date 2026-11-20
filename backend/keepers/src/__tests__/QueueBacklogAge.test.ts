import { getQueueHealth, QUEUE_HEALTH_THRESHOLDS } from '../queues/health';
import type { Queue } from 'bullmq';

interface MockQueueOptions {
  waitingJobs?: Array<{ timestamp: number }>;
  failedJobs?: Array<{ attemptsMade: number; opts?: { attempts?: number }; failedReason?: string }>;
  delayedJobs?: Array<{ id: string }>;
  counts?: Partial<Record<'waiting' | 'active' | 'completed' | 'failed' | 'delayed', number>>;
}

function createMockQueue(name: string, options: MockQueueOptions = {}): Queue {
  const {
    waitingJobs = [],
    failedJobs = [],
    counts = {},
  } = options;

  const fullCounts = {
    waiting: counts.waiting ?? waitingJobs.length,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? failedJobs.length,
    delayed: counts.delayed ?? 0,
  };

  return {
    name,
    getJobCounts: jest.fn().mockResolvedValue(fullCounts),
    getFailed: jest.fn().mockResolvedValue(failedJobs),
    getWaiting: jest.fn().mockImplementation((start: number, end: number) => {
      return Promise.resolve(waitingJobs.slice(start, end + 1));
    }),
  } as unknown as Queue;
}

describe('Queue Backlog Age Metrics (#1541)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Empty Queue', () => {
    it('reports zero queueLength, zero delayedLength, null oldestPendingAgeMs, and isStalled false', async () => {
      const emptyQueue = createMockQueue('empty-queue', {
        counts: { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0 },
        waitingJobs: [],
      });

      const summary = await getQueueHealth([emptyQueue]);
      expect(summary.queues).toHaveLength(1);

      const entry = summary.queues[0];
      expect(entry.counts.pending).toBe(0);
      expect(entry.counts.delayed).toBe(0);

      expect(entry.metrics).toBeDefined();
      expect(entry.metrics.queueLength).toBe(0);
      expect(entry.metrics.delayedLength).toBe(0);
      expect(entry.metrics.oldestPendingAgeMs).toBeNull();
      expect(entry.metrics.isStalled).toBe(false);
      expect(entry.status).toBe('healthy');
      expect(entry.warnings).toEqual([]);
    });
  });

  describe('Delayed Queue', () => {
    it('correctly tracks delayedLength when jobs are scheduled or backed off, without stalling waiting queue', async () => {
      const delayedQueue = createMockQueue('delayed-queue', {
        counts: { waiting: 0, delayed: 15, active: 1, completed: 50, failed: 0 },
        waitingJobs: [],
      });

      const summary = await getQueueHealth([delayedQueue]);
      const entry = summary.queues[0];

      expect(entry.counts.delayed).toBe(15);
      expect(entry.counts.pending).toBe(0);
      expect(entry.metrics.delayedLength).toBe(15);
      expect(entry.metrics.queueLength).toBe(0);
      expect(entry.metrics.oldestPendingAgeMs).toBeNull();
      expect(entry.metrics.isStalled).toBe(false);
    });
  });

  describe('Active Pending Queue (Healthy Backlog)', () => {
    it('calculates oldestPendingAgeMs for waiting jobs under the threshold without marking as stalled', async () => {
      const now = Date.now();
      const recentTimestamp = now - 15_000; // 15 seconds old (well below 30m default)

      const activeQueue = createMockQueue('active-queue', {
        counts: { waiting: 3, delayed: 0, active: 2, completed: 100, failed: 0 },
        waitingJobs: [{ timestamp: recentTimestamp }, { timestamp: now - 5000 }],
      });

      const summary = await getQueueHealth([activeQueue]);
      const entry = summary.queues[0];

      expect(entry.counts.pending).toBe(3);
      expect(entry.metrics.queueLength).toBe(3);
      expect(entry.metrics.oldestPendingAgeMs).toBeGreaterThanOrEqual(14_000);
      expect(entry.metrics.oldestPendingAgeMs).toBeLessThanOrEqual(30_000);
      expect(entry.metrics.isStalled).toBe(false);
      expect(entry.status).toBe('healthy');
    });
  });

  describe('Stalled Queue', () => {
    it('flags isStalled true and emits threshold warning when oldest pending job exceeds threshold', async () => {
      const threshold = QUEUE_HEALTH_THRESHOLDS.oldestPendingAgeMs;
      const now = Date.now();
      const stalledTimestamp = now - (threshold + 120_000); // 2 minutes over threshold

      const stalledQueue = createMockQueue('stalled-queue', {
        counts: { waiting: 5, delayed: 0, active: 0, completed: 10, failed: 0 },
        waitingJobs: [{ timestamp: stalledTimestamp }],
      });

      const summary = await getQueueHealth([stalledQueue]);
      const entry = summary.queues[0];

      expect(entry.metrics.queueLength).toBe(5);
      expect(entry.metrics.oldestPendingAgeMs).toBeGreaterThanOrEqual(threshold + 100_000);
      expect(entry.metrics.isStalled).toBe(true);
      expect(entry.status).toBe('warning');
      expect(entry.warnings.some((w) => w.includes('oldest pending job'))).toBe(true);
      expect(summary.overallStatus).toBe('warning');
    });
  });

  describe('Worker Mapping Integration', () => {
    it('populates queue metrics in both summary.queues and summary.workers maps', async () => {
      const now = Date.now();
      const queues = [
        createMockQueue('liquidation', {
          counts: { waiting: 1, delayed: 2, active: 0, completed: 10, failed: 0 },
          waitingJobs: [{ timestamp: now - 2000 }],
        }),
        createMockQueue('compound', {
          counts: { waiting: 0, delayed: 0, active: 1, completed: 20, failed: 0 },
          waitingJobs: [],
        }),
      ];

      const summary = await getQueueHealth(queues);

      expect(summary.workers).toBeDefined();
      const workers = summary.workers!;
      expect(workers.liquidationWorker).toBeDefined();
      expect(workers.liquidationWorker.metrics.queueLength).toBe(1);
      expect(workers.liquidationWorker.metrics.delayedLength).toBe(2);
      expect(workers.liquidationWorker.metrics.isStalled).toBe(false);

      expect(workers.compoundWorker).toBeDefined();
      expect(workers.compoundWorker.metrics.queueLength).toBe(0);
      expect(workers.compoundWorker.metrics.oldestPendingAgeMs).toBeNull();
      expect(workers.compoundWorker.metrics.isStalled).toBe(false);
    });
  });
});
