import { getQueueHealth, QUEUE_HEALTH_THRESHOLDS } from '../queues/health';
import type { Queue } from 'bullmq';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockJobOpts {
  /** BullMQ `getJobCounts` return value */
  counts?: Record<string, number>;
  /** Jobs returned by `getFailed(0, n-1)` — used for poison detection */
  failedJobs?: Array<{ attemptsMade: number; opts?: { attempts?: number }; failedReason?: string }>;
  /** Jobs returned by `getWaiting(0, 0)` — first pending job for age calc */
  waitingJobs?: Array<{ timestamp: number }>;
}

function makeQueue(name: string, opts: MockJobOpts = {}): Queue {
  const {
    counts = {},
    failedJobs = [],
    waitingJobs = [],
  } = opts;

  return {
    name,
    getJobCounts: jest.fn().mockResolvedValue(counts),
    getFailed: jest.fn().mockResolvedValue(failedJobs),
    getWaiting: jest.fn().mockResolvedValue(waitingJobs),
  } as unknown as Queue;
}

// ---------------------------------------------------------------------------
// Count fields
// ---------------------------------------------------------------------------

describe('getQueueHealth — counts', () => {
  it('includes all six count fields (pending, delayed, active, completed, failed, poison)', async () => {
    const queues = [
      makeQueue('liquidation', {
        counts: { waiting: 3, active: 2, completed: 100, failed: 1, delayed: 4 },
        failedJobs: [{ attemptsMade: 2, opts: { attempts: 5 }, failedReason: 'timeout' }],
      }),
    ];

    const summary = await getQueueHealth(queues);

    expect(summary.queues[0].counts).toEqual({
      pending: 3,
      delayed: 4,
      active: 2,
      completed: 100,
      failed: 1,
      poison: 0, // attemptsMade(2) < attempts(5) → not poison
    });
  });

  it('maps BullMQ "waiting" to "pending" in the output', async () => {
    const queues = [makeQueue('compound', { counts: { waiting: 7 } })];
    const summary = await getQueueHealth(queues);
    expect(summary.queues[0].counts.pending).toBe(7);
  });

  it('defaults missing count fields to 0', async () => {
    const queues = [makeQueue('liquidation', { counts: {} })];
    const summary = await getQueueHealth(queues);
    expect(summary.queues[0].counts).toEqual({
      pending: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      poison: 0,
    });
  });

  it('returns results for an empty queue list', async () => {
    const summary = await getQueueHealth([]);
    expect(summary.queues).toHaveLength(0);
    expect(summary.overallStatus).toBe('healthy');
    expect(summary.workers).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Poison detection
// ---------------------------------------------------------------------------

describe('getQueueHealth — poison count', () => {
  it('counts a job as poison when attemptsMade >= opts.attempts', async () => {
    const queues = [
      makeQueue('liquidation', {
        counts: { waiting: 0, failed: 2 },
        failedJobs: [
          { attemptsMade: 5, opts: { attempts: 5 }, failedReason: 'revert' },   // poison
          { attemptsMade: 3, opts: { attempts: 5 }, failedReason: 'timeout' },  // not poison
        ],
      }),
    ];

    const summary = await getQueueHealth(queues);
    expect(summary.queues[0].counts.poison).toBe(1);
  });

  it('counts all exhausted-retry jobs as poison when all have used up attempts', async () => {
    const queues = [
      makeQueue('compound', {
        counts: { waiting: 0, failed: 3 },
        failedJobs: [
          { attemptsMade: 5, opts: { attempts: 5 }, failedReason: 'err1' },
          { attemptsMade: 5, opts: { attempts: 5 }, failedReason: 'err2' },
          { attemptsMade: 5, opts: { attempts: 5 }, failedReason: 'err3' },
        ],
      }),
    ];

    const summary = await getQueueHealth(queues);
    expect(summary.queues[0].counts.poison).toBe(3);
  });

  it('defaults attempts to 1 when opts.attempts is absent', async () => {
    const queues = [
      makeQueue('liquidation', {
        counts: { waiting: 0, failed: 1 },
        // opts not provided → defaults to 1; attemptsMade=1 ≥ 1 → poison
        failedJobs: [{ attemptsMade: 1, failedReason: 'unknown' }],
      }),
    ];

    const summary = await getQueueHealth(queues);
    expect(summary.queues[0].counts.poison).toBe(1);
  });

  it('returns poison=0 when getFailed throws (resilience)', async () => {
    const queue = {
      name: 'liquidation',
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, failed: 2 }),
      getFailed: jest.fn().mockRejectedValue(new Error('Redis error')),
      getWaiting: jest.fn().mockResolvedValue([]),
    } as unknown as Queue;

    const summary = await getQueueHealth([queue]);
    expect(summary.queues[0].counts.poison).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Quality metrics — oldest pending age
// ---------------------------------------------------------------------------

describe('getQueueHealth — oldestPendingAgeMs', () => {
  it('returns null when there are no pending jobs', async () => {
    const queues = [makeQueue('compound', { counts: { waiting: 0 }, waitingJobs: [] })];
    const summary = await getQueueHealth(queues);
    expect(summary.queues[0].metrics.oldestPendingAgeMs).toBeNull();
  });

  it('returns age in ms based on first waiting job timestamp', async () => {
    const ageMs = 120_000; // 2 minutes
    const enqueuedAt = Date.now() - ageMs;
    const queues = [
      makeQueue('liquidation', {
        counts: { waiting: 1 },
        waitingJobs: [{ timestamp: enqueuedAt }],
      }),
    ];

    const summary = await getQueueHealth(queues);
    const reported = summary.queues[0].metrics.oldestPendingAgeMs!;
    // Allow ±500ms for execution time
    expect(reported).toBeGreaterThanOrEqual(ageMs - 500);
    expect(reported).toBeLessThanOrEqual(ageMs + 500);
  });

  it('returns null when getWaiting throws (resilience)', async () => {
    const queue = {
      name: 'compound',
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 5 }),
      getFailed: jest.fn().mockResolvedValue([]),
      getWaiting: jest.fn().mockRejectedValue(new Error('Redis timeout')),
    } as unknown as Queue;

    const summary = await getQueueHealth([queue]);
    expect(summary.queues[0].metrics.oldestPendingAgeMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Quality metrics — latest failure reason
// ---------------------------------------------------------------------------

describe('getQueueHealth — latestFailureReason', () => {
  it('returns null when there are no failed jobs', async () => {
    const queues = [makeQueue('compound', { counts: { waiting: 0, failed: 0 } })];
    const summary = await getQueueHealth(queues);
    expect(summary.queues[0].metrics.latestFailureReason).toBeNull();
  });

  it('returns the failedReason from the most recent failure', async () => {
    const queues = [
      makeQueue('liquidation', {
        counts: { waiting: 0, failed: 2 },
        failedJobs: [
          { attemptsMade: 5, opts: { attempts: 5 }, failedReason: 'Liquidation blocked by dry-run policy: stale_price' },
          { attemptsMade: 5, opts: { attempts: 5 }, failedReason: 'older error' },
        ],
      }),
    ];

    const summary = await getQueueHealth(queues);
    expect(summary.queues[0].metrics.latestFailureReason).toBe(
      'Liquidation blocked by dry-run policy: stale_price',
    );
  });

  it('returns null when getFailed throws (resilience)', async () => {
    const queue = {
      name: 'liquidation',
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, failed: 1 }),
      getFailed: jest.fn().mockRejectedValue(new Error('Redis error')),
      getWaiting: jest.fn().mockResolvedValue([]),
    } as unknown as Queue;

    const summary = await getQueueHealth([queue]);
    expect(summary.queues[0].metrics.latestFailureReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Threshold-based warnings
// ---------------------------------------------------------------------------

describe('getQueueHealth — warnings', () => {
  it('returns healthy status when all counts are below thresholds', async () => {
    const queues = [
      makeQueue('liquidation', { counts: { waiting: 2, active: 1, completed: 50, failed: 0, delayed: 0 } }),
      makeQueue('compound', { counts: { waiting: 0, active: 0, completed: 10, failed: 1, delayed: 3 } }),
    ];

    const summary = await getQueueHealth(queues);

    expect(summary.overallStatus).toBe('healthy');
    expect(summary.queues).toHaveLength(2);
    expect(summary.queues[0].status).toBe('healthy');
    expect(summary.queues[0].warnings).toHaveLength(0);
    expect(summary.queues[1].status).toBe('healthy');
  });

  it('warns when failed jobs exceed threshold', async () => {
    const failedCount = QUEUE_HEALTH_THRESHOLDS.failed + 1;
    const queues = [
      makeQueue('liquidation', { counts: { waiting: 0, active: 0, completed: 0, failed: failedCount, delayed: 0 } }),
    ];

    const summary = await getQueueHealth(queues);

    expect(summary.overallStatus).toBe('warning');
    expect(summary.queues[0].status).toBe('warning');
    expect(summary.queues[0].warnings.some((w) => /failed jobs/.test(w))).toBe(true);
  });

  it('warns when delayed jobs exceed threshold', async () => {
    const delayedCount = QUEUE_HEALTH_THRESHOLDS.delayed + 1;
    const queues = [
      makeQueue('compound', { counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: delayedCount } }),
    ];

    const summary = await getQueueHealth(queues);

    expect(summary.overallStatus).toBe('warning');
    expect(summary.queues[0].warnings.some((w) => /delayed jobs/.test(w))).toBe(true);
  });

  it('warns when pending jobs exceed threshold', async () => {
    const pendingCount = QUEUE_HEALTH_THRESHOLDS.pending + 1;
    const queues = [
      makeQueue('liquidation', { counts: { waiting: pendingCount, active: 0, completed: 0, failed: 0, delayed: 0 } }),
    ];

    const summary = await getQueueHealth(queues);

    expect(summary.queues[0].status).toBe('warning');
    expect(summary.queues[0].warnings.some((w) => /pending jobs/.test(w))).toBe(true);
  });

  it('warns when poison jobs exceed threshold', async () => {
    const poisonCount = QUEUE_HEALTH_THRESHOLDS.poison + 1;
    const failedJobs = Array.from({ length: poisonCount }, () => ({
      attemptsMade: 5,
      opts: { attempts: 5 },
      failedReason: 'contract revert',
    }));
    const queues = [
      makeQueue('compound', {
        counts: { waiting: 0, failed: poisonCount, delayed: 0 },
        failedJobs,
      }),
    ];

    const summary = await getQueueHealth(queues);

    expect(summary.queues[0].status).toBe('warning');
    expect(summary.queues[0].warnings.some((w) => /poison jobs/.test(w))).toBe(true);
    expect(summary.queues[0].warnings.some((w) => /manual intervention/.test(w))).toBe(true);
  });

  it('warns when oldest pending job age exceeds threshold', async () => {
    const overdueMs = QUEUE_HEALTH_THRESHOLDS.oldestPendingAgeMs + 60_000; // 1 min over
    const enqueuedAt = Date.now() - overdueMs;
    const queues = [
      makeQueue('liquidation', {
        counts: { waiting: 1 },
        waitingJobs: [{ timestamp: enqueuedAt }],
      }),
    ];

    const summary = await getQueueHealth(queues);

    expect(summary.queues[0].status).toBe('warning');
    expect(summary.queues[0].warnings.some((w) => /oldest pending job/.test(w))).toBe(true);
  });

  it('emits multiple warnings when several thresholds are exceeded', async () => {
    const queues = [
      makeQueue('liquidation', {
        counts: {
          waiting: 0,
          active: 0,
          completed: 0,
          failed: QUEUE_HEALTH_THRESHOLDS.failed + 5,
          delayed: QUEUE_HEALTH_THRESHOLDS.delayed + 10,
        },
      }),
    ];

    const summary = await getQueueHealth(queues);
    // failed + delayed → at least 2 warnings
    expect(summary.queues[0].warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('sets overallStatus to warning when at least one queue warns', async () => {
    const queues = [
      makeQueue('liquidation', { counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 } }),
      makeQueue('compound', {
        counts: { waiting: 0, active: 0, completed: 0, failed: QUEUE_HEALTH_THRESHOLDS.failed + 1, delayed: 0 },
      }),
    ];

    const summary = await getQueueHealth(queues);

    expect(summary.queues[0].status).toBe('healthy');
    expect(summary.queues[1].status).toBe('warning');
    expect(summary.overallStatus).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// Per-worker metrics map
// ---------------------------------------------------------------------------

describe('getQueueHealth — workers map', () => {
  it('exposes a "liquidationWorker" entry mirroring the liquidation queue', async () => {
    const queues = [
      makeQueue('liquidation', { counts: { waiting: 2, active: 1, completed: 10, failed: 0, delayed: 0 } }),
    ];

    const summary = await getQueueHealth(queues);

    expect(summary.workers).toHaveProperty('liquidationWorker');
    expect(summary.workers['liquidationWorker'].name).toBe('liquidation');
    expect(summary.workers['liquidationWorker'].counts.pending).toBe(2);
    expect(summary.workers['liquidationWorker'].counts.active).toBe(1);
  });

  it('exposes a "compoundWorker" entry mirroring the compound queue', async () => {
    const queues = [
      makeQueue('compound', { counts: { waiting: 0, active: 3, completed: 20, failed: 2, delayed: 5 } }),
    ];

    const summary = await getQueueHealth(queues);

    expect(summary.workers).toHaveProperty('compoundWorker');
    expect(summary.workers['compoundWorker'].counts.completed).toBe(20);
    expect(summary.workers['compoundWorker'].counts.failed).toBe(2);
  });

  it('exposes both workers when both queues are provided', async () => {
    const queues = [
      makeQueue('liquidation', { counts: { waiting: 1, active: 0, completed: 5, failed: 0, delayed: 0 } }),
      makeQueue('compound', { counts: { waiting: 0, active: 2, completed: 15, failed: 1, delayed: 0 } }),
    ];

    const summary = await getQueueHealth(queues);

    expect(Object.keys(summary.workers)).toEqual(
      expect.arrayContaining(['liquidationWorker', 'compoundWorker']),
    );
  });

  it('worker entries contain counts, metrics, status, and warnings', async () => {
    const queues = [
      makeQueue('compound', { counts: { waiting: 0, active: 0, completed: 5, failed: 0, delayed: 0 } }),
    ];

    const summary = await getQueueHealth(queues);
    const worker = summary.workers['compoundWorker'];

    expect(worker).toHaveProperty('counts');
    expect(worker).toHaveProperty('metrics');
    expect(worker).toHaveProperty('status');
    expect(worker).toHaveProperty('warnings');
  });
});

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

describe('getQueueHealth — timestamp', () => {
  it('includes a valid ISO timestamp', async () => {
    const before = Date.now();
    const summary = await getQueueHealth([makeQueue('liquidation', {})]);
    const after = Date.now();

    const ts = new Date(summary.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
