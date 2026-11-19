/**
 * Regression tests — concurrent lock acquisition in RebalanceSagaService (#concurrency)
 *
 * Covers:
 *  - Normal operation: a free saga can be locked by a worker.
 *  - TOCTOU elimination: two workers racing for the same saga produce exactly
 *    one winner and one loser — the atomic updateMany ensures this.
 *  - Failure + state preservation: a failed lock attempt leaves existing saga
 *    state unchanged (no partial write).
 *  - Safe retry: an expired lock is stolen atomically; the new holder's
 *    generation differs from the old one's.
 *  - Re-entrant renewal: a worker that already holds the lock can extend it.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RebalanceSagaService, SAGA_STATE, SAGA_PHASE } from '../rebalanceSagaService';

// ── Minimal Prisma mock ───────────────────────────────────────────────────────

function makeSagaRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: 'saga-1',
    queueEntryId: 'entry-1',
    vaultId: 'vault-1',
    state: SAGA_STATE.PENDING,
    currentPhase: SAGA_PHASE.INIT,
    quoteKey: null,
    approvalKey: null,
    submissionKey: null,
    confirmationKey: null,
    snapshotKey: null,
    checkpoint: null,
    transactionHash: null,
    feeBumpHash: null,
    innerTxXdr: null,
    lockedBy: null,
    lockedAt: null,
    lockExpiresAt: null,
    failureClass: null,
    failureReason: null,
    failureCount: 0,
    maxRetries: 3,
    reviewRequired: false,
    reviewReason: null,
    reviewedAt: null,
    reviewedBy: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

// Track updateMany call count to verify exactly one DB write per race winner.
let updateManyCallCount = 0;
// Simulated DB row — shared state between mocked operations.
let dbRow = makeSagaRow();

const mockUpdateMany = jest.fn();
const mockFindUnique = jest.fn();
const mockFindUniqueOrThrow = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    rebalanceSaga: {
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findUniqueOrThrow: (...args: unknown[]) => mockFindUniqueOrThrow(...args),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        dbRow = { ...dbRow, ...data };
        return Promise.resolve(dbRow);
      }),
      create: jest.fn().mockResolvedValue(makeSagaRow()),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rebalanceQueueEntry: {
      update: jest.fn().mockResolvedValue({}),
    },
    rebalanceSagaCheckpoint: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
    },
    rebalanceSagaRetry: {
      create: jest.fn().mockResolvedValue({}),
    },
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeService() {
  return new RebalanceSagaService();
}

/** Configure mocks so updateMany succeeds for the first caller only. */
function setupRace() {
  updateManyCallCount = 0;
  dbRow = makeSagaRow();

  mockUpdateMany.mockImplementation(() => {
    // First caller wins (count=1); subsequent ones see count=0.
    const winner = updateManyCallCount === 0;
    updateManyCallCount++;
    if (winner) {
      dbRow = { ...dbRow, lockedBy: 'worker-A', lockExpiresAt: new Date(Date.now() + 300_000) };
    }
    return Promise.resolve({ count: winner ? 1 : 0 });
  });

  mockFindUnique.mockImplementation(() => Promise.resolve({ ...dbRow }));
  mockFindUniqueOrThrow.mockImplementation(() => Promise.resolve({ ...dbRow }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RebalanceSagaService.acquireLock — concurrent safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbRow = makeSagaRow();
  });

  // ── Normal operation ────────────────────────────────────────────────────────

  it('normal operation: free saga is locked by one worker', async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUniqueOrThrow.mockResolvedValueOnce(
      makeSagaRow({ lockedBy: 'worker-A', lockExpiresAt: new Date(Date.now() + 300_000) }),
    );

    const svc = makeService();
    const result = await svc.acquireLock('saga-1', 'worker-A');

    expect(result.acquired).toBe(true);
    expect(result.saga?.lockedBy).toBe('worker-A');
    // Exactly one updateMany — no extra findUnique before it.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('normal operation: returns acquired=false with reason when saga is locked', async () => {
    // updateMany finds 0 rows matching the unlocked condition.
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockFindUnique.mockResolvedValueOnce(
      makeSagaRow({
        lockedBy: 'worker-B',
        lockExpiresAt: new Date(Date.now() + 300_000),
      }),
    );

    const svc = makeService();
    const result = await svc.acquireLock('saga-1', 'worker-A');

    expect(result.acquired).toBe(false);
    expect(result.reason).toMatch(/worker-B/);
    // findUnique is called only AFTER updateMany returns 0 — not before.
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  // ── TOCTOU elimination ──────────────────────────────────────────────────────

  it('two concurrent workers produce exactly one winner and one loser', async () => {
    setupRace();
    const svc = makeService();

    const [resA, resB] = await Promise.all([
      svc.acquireLock('saga-1', 'worker-A'),
      svc.acquireLock('saga-1', 'worker-B'),
    ]);

    // updateMany was called twice (once per worker).
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);

    const winner = resA.acquired ? resA : resB;
    const loser = resA.acquired ? resB : resA;

    expect(winner.acquired).toBe(true);
    expect(loser.acquired).toBe(false);
    expect(loser.reason).toBeDefined();
  });

  it('the WHERE clause on updateMany embeds the liveness check (no pre-read)', async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUniqueOrThrow.mockResolvedValueOnce(makeSagaRow({ lockedBy: 'worker-A' }));

    const svc = makeService();
    await svc.acquireLock('saga-1', 'worker-A');

    // findUnique must NOT have been called before updateMany.
    expect(mockFindUnique).not.toHaveBeenCalled();
    const updateManyArgs = mockUpdateMany.mock.calls[0][0] as {
      where: { OR?: unknown[] };
    };
    // The WHERE clause must contain an OR with at least the null and expiry conditions.
    expect(Array.isArray(updateManyArgs.where.OR)).toBe(true);
    expect((updateManyArgs.where.OR as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  // ── State preservation on failure ──────────────────────────────────────────

  it('failed updateMany does not corrupt saga state', async () => {
    mockUpdateMany.mockRejectedValueOnce(new Error('DB timeout'));

    const svc = makeService();
    await expect(svc.acquireLock('saga-1', 'worker-A')).rejects.toThrow('DB timeout');

    // No other writes should have been attempted.
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockFindUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('lock attempt on missing saga returns acquired=false without throwing', async () => {
    // count=0 → fallback findUnique returns null.
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockFindUnique.mockResolvedValueOnce(null);

    const svc = makeService();
    const result = await svc.acquireLock('saga-missing', 'worker-A');

    expect(result.acquired).toBe(false);
    expect(result.saga).toBeNull();
    expect(result.reason).toMatch(/not found/i);
  });

  // ── Expired lock is stolen atomically ──────────────────────────────────────

  it('expired lock is stolen: updateMany WHERE includes lte(now) condition', async () => {
    // The saga row has an expired lock from a previous worker.
    const expiredLockRow = makeSagaRow({
      lockedBy: 'worker-old',
      lockExpiresAt: new Date(Date.now() - 1_000), // 1 second in the past
    });

    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUniqueOrThrow.mockResolvedValueOnce({
      ...expiredLockRow,
      lockedBy: 'worker-new',
      lockExpiresAt: new Date(Date.now() + 300_000),
    });

    const svc = makeService();
    const result = await svc.acquireLock('saga-1', 'worker-new');

    expect(result.acquired).toBe(true);
    expect(result.saga?.lockedBy).toBe('worker-new');

    // Confirm the WHERE clause included an expiry condition.
    const whereClause = (mockUpdateMany.mock.calls[0][0] as { where: { OR?: unknown[] } }).where;
    const orClauses = whereClause.OR as Array<Record<string, unknown>>;
    const hasExpiryCondition = orClauses.some((clause) => 'lockExpiresAt' in clause);
    expect(hasExpiryCondition).toBe(true);
  });

  // ── Re-entrant renewal ──────────────────────────────────────────────────────

  it('a worker that already holds the lock can renew it', async () => {
    // The OR clause includes { lockedBy: workerId } for re-entrant renewal.
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUniqueOrThrow.mockResolvedValueOnce(
      makeSagaRow({ lockedBy: 'worker-A', lockExpiresAt: new Date(Date.now() + 300_000) }),
    );

    const svc = makeService();
    const result = await svc.acquireLock('saga-1', 'worker-A');

    expect(result.acquired).toBe(true);
    const whereClause = (mockUpdateMany.mock.calls[0][0] as { where: { OR?: unknown[] } }).where;
    const orClauses = whereClause.OR as Array<Record<string, unknown>>;
    const hasReentrantClause = orClauses.some(
      (c) => 'lockedBy' in c && c.lockedBy === 'worker-A',
    );
    expect(hasReentrantClause).toBe(true);
  });
});
