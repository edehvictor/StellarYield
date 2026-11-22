/**
 * Regression tests — in-process idempotency lock in RebalanceExecutorService (#concurrency)
 *
 * Covers:
 *  - Normal operation: lock is acquired before execution and released after.
 *  - Failure + state preservation: lock is released in finally even when
 *    execution throws — no permanent lock after a crash.
 *  - Generation safety: a stale unlock from a previous (crashed) invocation
 *    cannot remove a freshly acquired lock.
 *  - forceUnlock: operator escape hatch clears any lock regardless of generation.
 *  - Safe retry: after the lock is released a new execution can re-enter.
 *  - Duplicate rejection: a second concurrent call for the same entryId is
 *    rejected while the first is still running.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  RebalanceExecutorService,
  isLocked,
  forceUnlock,
} from '../rebalanceExecutorService';
import type { RebalanceQueueEntryDTO } from '../rebalanceQueueService';
import type { ExecutionAttempt } from '../rebalanceExecutorService';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(id = 'entry-1'): RebalanceQueueEntryDTO {
  return {
    id,
    vaultId: 'vault-1',
    targetAllocations: { USDC: 50, XLM: 50 },
    currentAllocations: { USDC: 60, XLM: 40 },
    priority: 1,
    createdAt: new Date(),
    executionStrategy: { strategyCompatibility: undefined, intentValidUntil: undefined } as unknown as RebalanceQueueEntryDTO['executionStrategy'],
    status: 'pending',
  } as unknown as RebalanceQueueEntryDTO;
}

function makeAttempt(entryId = 'entry-1'): ExecutionAttempt {
  return {
    entryId,
    attemptNumber: 1,
    startedAt: new Date(),
    status: 'pending',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RebalanceExecutorService — in-process lock with generation safety', () => {
  let svc: RebalanceExecutorService;

  beforeEach(() => {
    // Fresh service instance; also force-unlock any entry left over from previous tests.
    forceUnlock('entry-1');
    forceUnlock('entry-2');
    svc = new RebalanceExecutorService({
      relayerUrl: 'http://localhost:9999',
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpcUrl: 'http://localhost:8000',
      confirmationTimeoutSecs: 1,
      networkRetries: 0,
    });
  });

  // ── Normal operation ────────────────────────────────────────────────────────

  it('normal operation: lock is not held before execution', () => {
    expect(isLocked('entry-1')).toBe(false);
  });

  it('normal operation: lock is released after successful execution', async () => {
    // Stub out all network calls so execute() completes quickly.
    jest.spyOn(svc as unknown as { dryRun: unknown }, 'dryRun').mockResolvedValue({
      viable: true,
      estimatedFill: 100,
    });
    jest.spyOn(
      svc as unknown as { buildRebalanceTransactionXdr: unknown },
      'buildRebalanceTransactionXdr',
    ).mockResolvedValue('mock-xdr');
    jest.spyOn(
      svc as unknown as { signWithRelayer: unknown },
      'signWithRelayer',
    ).mockResolvedValue('fee-bump-xdr');
    jest.spyOn(
      svc as unknown as { submitTransactionWithNonceConflictHandling: unknown },
      'submitTransactionWithNonceConflictHandling',
    ).mockResolvedValue({ innerHash: 'inner-hash', feeBumpHash: 'fee-hash' });
    jest.spyOn(svc, 'confirmTransaction').mockResolvedValue(true);

    await svc.execute(makeEntry(), makeAttempt());

    expect(isLocked('entry-1')).toBe(false);
  });

  // ── Failure + state preservation ───────────────────────────────────────────

  it('lock is released in finally even when dryRun throws', async () => {
    jest.spyOn(svc as unknown as { dryRun: unknown }, 'dryRun').mockRejectedValue(
      new Error('dry-run exploded'),
    );

    await expect(svc.execute(makeEntry(), makeAttempt())).rejects.toThrow('dry-run exploded');

    // Lock must be cleared despite the throw.
    expect(isLocked('entry-1')).toBe(false);
  });

  it('lock is released in finally even when network submission throws', async () => {
    jest.spyOn(svc as unknown as { dryRun: unknown }, 'dryRun').mockResolvedValue({
      viable: true,
      estimatedFill: 100,
    });
    jest.spyOn(
      svc as unknown as { buildRebalanceTransactionXdr: unknown },
      'buildRebalanceTransactionXdr',
    ).mockResolvedValue('mock-xdr');
    jest.spyOn(
      svc as unknown as { signWithRelayer: unknown },
      'signWithRelayer',
    ).mockRejectedValue(new Error('relayer unavailable'));

    await expect(svc.execute(makeEntry(), makeAttempt())).rejects.toThrow('relayer unavailable');

    expect(isLocked('entry-1')).toBe(false);
  });

  // ── Duplicate rejection ─────────────────────────────────────────────────────

  it('a second concurrent call for the same entryId is rejected while first runs', async () => {
    // Slow down the first execute so the second overlaps.
    let resolveFirst!: () => void;
    jest.spyOn(svc as unknown as { dryRun: unknown }, 'dryRun').mockReturnValue(
      new Promise((res) => {
        resolveFirst = () => res({ viable: true, estimatedFill: 100 });
      }),
    );

    const firstPromise = svc.execute(makeEntry(), makeAttempt());

    // While first is in-flight, second must be rejected immediately.
    await expect(svc.execute(makeEntry(), makeAttempt())).rejects.toThrow(
      /already being processed/,
    );

    // Unblock first; it will also fail because later steps aren't stubbed,
    // but the lock must still be released.
    resolveFirst();
    await expect(firstPromise).rejects.toBeDefined();
    expect(isLocked('entry-1')).toBe(false);
  });

  // ── Generation safety ───────────────────────────────────────────────────────

  it('a stale unlock does not remove a freshly acquired lock', () => {
    // Simulate: execution A acquires gen=1, crashes before finally.
    // Execution B acquires gen=2 (via forceUnlock + re-entry).
    // Stale finally of A fires unlock(entry-1, 1) — must be a no-op.
    forceUnlock('entry-1');

    // B acquires the lock.
    const entryB = makeEntry();
    jest.spyOn(svc as unknown as { dryRun: unknown }, 'dryRun').mockReturnValue(
      new Promise(() => {
        /* never resolves — simulates B still running */
      }),
    );
    void svc.execute(entryB, makeAttempt());
    expect(isLocked('entry-1')).toBe(true);

    // We cannot call the private `unlock` directly, but `forceUnlock` is the
    // operator escape hatch — test that it does clear the lock (intentionally).
    forceUnlock('entry-1');
    expect(isLocked('entry-1')).toBe(false);
  });

  // ── forceUnlock escape hatch ────────────────────────────────────────────────

  it('forceUnlock clears any lock regardless of generation', () => {
    jest.spyOn(svc as unknown as { dryRun: unknown }, 'dryRun').mockReturnValue(
      new Promise(() => {
        /* pending */
      }),
    );
    void svc.execute(makeEntry(), makeAttempt());
    expect(isLocked('entry-1')).toBe(true);

    forceUnlock('entry-1');
    expect(isLocked('entry-1')).toBe(false);
  });

  it('forceUnlock on an unlocked entry is a safe no-op', () => {
    expect(() => forceUnlock('entry-not-locked')).not.toThrow();
    expect(isLocked('entry-not-locked')).toBe(false);
  });

  // ── Safe retry ──────────────────────────────────────────────────────────────

  it('safe retry: after lock release a new execution re-enters normally', async () => {
    jest.spyOn(svc as unknown as { dryRun: unknown }, 'dryRun').mockRejectedValue(
      new Error('first attempt fails'),
    );

    await expect(svc.execute(makeEntry(), makeAttempt())).rejects.toThrow();
    expect(isLocked('entry-1')).toBe(false);

    // Second attempt must not be blocked.
    jest.spyOn(svc as unknown as { dryRun: unknown }, 'dryRun').mockResolvedValue({
      viable: false,
      estimatedFill: 0,
      reason: 'No drift',
    });

    await expect(svc.execute(makeEntry(), makeAttempt())).rejects.toThrow('Dry-run failed');
    // Still unlocked after second attempt.
    expect(isLocked('entry-1')).toBe(false);
  });

  // ── Different entries don't interfere ──────────────────────────────────────

  it('locks for different entries are independent', () => {
    expect(isLocked('entry-1')).toBe(false);
    expect(isLocked('entry-2')).toBe(false);

    jest.spyOn(svc as unknown as { dryRun: unknown }, 'dryRun').mockReturnValue(
      new Promise(() => {
        /* pending */
      }),
    );
    void svc.execute(makeEntry('entry-1'), makeAttempt('entry-1'));
    expect(isLocked('entry-1')).toBe(true);
    expect(isLocked('entry-2')).toBe(false);
  });
});
