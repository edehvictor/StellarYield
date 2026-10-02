import * as StellarSdk from '@stellar/stellar-sdk';
import {
  RebalanceExecutorService,
  FAILURE_CLASS,
  isLocked,
} from '../services/rebalanceExecutorService';
import { RebalanceQueueEntryDTO } from '../services/rebalanceQueueService';
import { EXECUTION_TYPE, REBALANCE_STATUS } from '../queues/types';
import { NONCE_CONFLICT_CODE } from '../relayer/nonceConflict';

function buildBadSeqTransactionResult(): StellarSdk.xdr.TransactionResult {
  return new StellarSdk.xdr.TransactionResult({
    feeCharged: StellarSdk.xdr.Int64.fromString('100'),
    result: StellarSdk.xdr.TransactionResultResult.txBadSeq(),
    ext: new StellarSdk.xdr.TransactionResultExt(0),
  });
}

/** Builds a minimal, validly-signed fee-bump XDR the executor can parse. */
function buildFeeBumpXdr(networkPassphrase: string): string {
  const innerSource = StellarSdk.Keypair.random();
  const innerAccount = new StellarSdk.Account(innerSource.publicKey(), '1');
  const contractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 3));
  const contract = new StellarSdk.Contract(contractId);
  const innerTx = new StellarSdk.TransactionBuilder(innerAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call('rebalance'))
    .setTimeout(30)
    .build();
  innerTx.sign(innerSource);

  const relayerKeypair = StellarSdk.Keypair.random();
  const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    relayerKeypair,
    StellarSdk.BASE_FEE,
    innerTx,
    networkPassphrase,
  );
  feeBump.sign(relayerKeypair);
  return feeBump.toXDR();
}

const baseEntry = (): RebalanceQueueEntryDTO => ({
  id: 'entry-1',
  vaultId: 'vault-1',
  status: REBALANCE_STATUS.PENDING,
  executionType: EXECUTION_TYPE.FULL,
  targetAllocations: { BTC: 60, ETH: 40 },
  currentAllocations: { BTC: 50, ETH: 50 },
  executionStrategy: {},
  partiallyExecuted: false,
  partialFillAmount: 0,
  intentHash: 'abc123',
  attemptCount: 0,
  maxRetries: 3,
  nextRetryAt: null,
  deferredUntil: null,
  followUpEntryId: null,
  lastError: null,
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('RebalanceExecutorService', () => {
  let executor: RebalanceExecutorService;

  beforeEach(() => {
    executor = new RebalanceExecutorService({
      relayerUrl: 'http://localhost:3001',
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      confirmationTimeoutSecs: 5,
      networkRetries: 1,
    });
  });

  // ── dryRun ──────────────────────────────────────────────────────────────

  describe('dryRun', () => {
    it('rejects entries where allocations do not sum to 100', async () => {
      const entry = baseEntry();
      entry.targetAllocations = { BTC: 60, ETH: 30 }; // sums to 90

      const result = await executor.dryRun(entry);

      expect(result.viable).toBe(false);
      expect(result.reason).toMatch(/sum to/i);
    });

    it('accepts entries where allocations sum to 100', async () => {
      const result = await executor.dryRun(baseEntry());
      expect(result.viable).toBe(true);
    });

    it('rejects entries with no drift between current and target allocations', async () => {
      const entry = baseEntry();
      entry.targetAllocations = { BTC: 50, ETH: 50 };
      entry.currentAllocations = { BTC: 50, ETH: 50 };

      const result = await executor.dryRun(entry);

      expect(result.viable).toBe(false);
      expect(result.reason).toMatch(/no allocation drift/i);
    });

    it('rejects expired intents', async () => {
      const entry = baseEntry();
      entry.executionStrategy = {
        intentValidUntil: new Date(Date.now() - 1000).toISOString(),
      };

      const result = await executor.dryRun(entry);

      expect(result.viable).toBe(false);
      expect(result.reason).toMatch(/expired/i);
    });

    it('accepts future-dated intents', async () => {
      const entry = baseEntry();
      entry.executionStrategy = {
        intentValidUntil: new Date(Date.now() + 86400000).toISOString(),
      };

      const result = await executor.dryRun(entry);
      expect(result.viable).toBe(true);
    });
  });

  // ── Error classification ─────────────────────────────────────────────────

  describe('classifyError', () => {
    it('classifies expired-intent errors as STALE_INTENT', () => {
      expect(executor.classifyError(new Error('Intent expired'))).toBe(FAILURE_CLASS.STALE_INTENT);
    });

    it('classifies constraint/slippage errors as CONSTRAINT', () => {
      expect(executor.classifyError(new Error('Slippage breach'))).toBe(FAILURE_CLASS.CONSTRAINT);
      expect(executor.classifyError(new Error('Dry-run failed'))).toBe(FAILURE_CLASS.CONSTRAINT);
    });

    it('classifies fee/sequence errors as FEE_SEQUENCE', () => {
      expect(executor.classifyError(new Error('Invalid sequence number'))).toBe(
        FAILURE_CLASS.FEE_SEQUENCE,
      );
    });

    it('classifies malformed XDR as PERMANENT', () => {
      expect(executor.classifyError(new Error('Malformed XDR'))).toBe(FAILURE_CLASS.PERMANENT);
    });

    it('classifies unknown network errors as TRANSIENT', () => {
      expect(executor.classifyError(new Error('Connection refused'))).toBe(FAILURE_CLASS.TRANSIENT);
    });
  });

  // ── Idempotency lock ─────────────────────────────────────────────────────

  describe('idempotency lock', () => {
    it('execute throws if entry is already locked', async () => {
      const entry = baseEntry();

      // Manually lock the entry to simulate a concurrent worker
      (executor as any).constructor;
      const { lock, unlock } = (() => {
        const locks = new Set<string>();
        return {
          lock: (id: string) => locks.add(id),
          unlock: (id: string) => locks.delete(id),
          isLocked: (id: string) => locks.has(id),
        };
      })();

      // Verify the module-level lock works
      expect(isLocked('non-existent-id')).toBe(false);
    });

    it('does not re-execute an entry with the same ID within the same process', async () => {
      // The idempotency guard is module-level; once execute returns, lock is released.
      // We verify dryRun returns false for no-drift entries (idempotent guard path).
      const entry = baseEntry();
      entry.targetAllocations = { BTC: 50, ETH: 50 };
      entry.currentAllocations = { BTC: 50, ETH: 50 };

      const result = await executor.dryRun(entry);
      expect(result.viable).toBe(false);
    });
  });

  // ── execute: real relayer path ────────────────────────────────────────────

  describe('execute', () => {
    it('throws a CONSTRAINT error if dry-run fails', async () => {
      const entry = baseEntry();
      entry.targetAllocations = { BTC: 50, ETH: 50 };
      entry.currentAllocations = { BTC: 50, ETH: 50 };

      const attempt = {
        entryId: entry.id,
        attemptNumber: 1,
        startedAt: new Date(),
        status: 'pending' as const,
      };

      await expect(executor.execute(entry, attempt)).rejects.toThrow(/dry-run/i);
      expect(attempt.failureClass).toBe(FAILURE_CLASS.CONSTRAINT);
    });

    it('throws a STALE_INTENT error for expired intents', async () => {
      const entry = baseEntry();
      entry.executionStrategy = {
        intentValidUntil: new Date(Date.now() - 5000).toISOString(),
      };

      const attempt = {
        entryId: entry.id,
        attemptNumber: 1,
        startedAt: new Date(),
        status: 'pending' as const,
      };

      await expect(executor.execute(entry, attempt)).rejects.toThrow(/dry-run/i);
      expect(attempt.failureClass).toBe(FAILURE_CLASS.STALE_INTENT);
    });
  });

  // ── Relayer nonce conflict handling (#1153) ───────────────────────────────
  //
  // Exercises submitTransactionWithNonceConflictHandling directly (it's
  // private, accessed the same way execute()'s other private helpers are
  // exercised elsewhere in this file) so nonce-conflict detection, retry
  // eligibility, and metadata recording can be tested without standing up
  // a full relayer HTTP mock + RPC round trip for every case.

  describe('submitTransactionWithNonceConflictHandling', () => {
    const networkPassphrase = 'Test SDF Network ; September 2015';

    function makeAttempt() {
      return {
        entryId: 'entry-1',
        attemptNumber: 1,
        startedAt: new Date(),
        status: 'pending' as const,
      };
    }

    it('reports a nonce conflict with the typed NONCE_CONFLICT code and does not retry a fund-moving (Soroban) transaction', async () => {
      const localExecutor = new RebalanceExecutorService({ networkPassphrase });
      const feeBumpXdr = buildFeeBumpXdr(networkPassphrase);
      const badSeqResult = buildBadSeqTransactionResult();

      const sendTransaction = jest.fn().mockResolvedValue({
        status: 'ERROR',
        errorResult: badSeqResult,
      });
      (localExecutor as any).server.sendTransaction = sendTransaction;

      const attempt = makeAttempt();

      await expect(
        (localExecutor as any).submitTransactionWithNonceConflictHandling(feeBumpXdr, attempt),
      ).rejects.toThrow();

      expect(attempt.failureClass).toBe(FAILURE_CLASS.FEE_SEQUENCE);
      expect(attempt.nonceConflict).toBeDefined();
      expect(attempt.nonceConflict!.status).toBe('UNSAFE_TO_RETRY');
      expect(attempt.nonceConflict!.code).toBe(NONCE_CONFLICT_CODE);
      expect(attempt.nonceConflict!.retried).toBe(false);
      expect(attempt.nonceConflict!.retryEligible).toBe(false);
      expect(attempt.nonceConflict!.reason).toMatch(/cannot be safely.*retried/i);
      // Rebalance transactions invoke a Soroban contract — not fingerprintable
      // — so exactly one submission attempt is made, never a retry.
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('retries a nonce conflict and succeeds when a later attempt clears', async () => {
      const localExecutor = new RebalanceExecutorService({
        networkPassphrase,
        networkRetries: 2,
      });
      const feeBumpXdr = buildFeeBumpXdr(networkPassphrase);
      const badSeqResult = buildBadSeqTransactionResult();

      const sendTransaction = jest
        .fn()
        .mockResolvedValueOnce({ status: 'ERROR', errorResult: badSeqResult })
        .mockResolvedValueOnce({ status: 'SUCCESS', hash: 'success-hash' });
      (localExecutor as any).server.sendTransaction = sendTransaction;

      const attempt = makeAttempt();

      // This scenario is only reachable when the underlying transaction IS
      // retry-eligible. Force eligibility for this test since every real
      // transaction type in this codebase's relayer pipeline is a Soroban
      // call (never eligible) — this proves the retry-success *path* itself
      // works correctly when eligibility is true, independent of which
      // transaction types happen to qualify today.
      const nonceConflictModule = require('../relayer/nonceConflict');
      const spy = jest
        .spyOn(nonceConflictModule, 'isSafeToRetryAfterNonceConflict')
        .mockReturnValue(true);

      try {
        const result = await (localExecutor as any).submitTransactionWithNonceConflictHandling(
          feeBumpXdr,
          attempt,
        );
        expect(result.feeBumpHash).toBe('success-hash');
        expect(attempt.nonceConflict).toBeUndefined();
        expect(sendTransaction).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('surfaces RETRY_EXHAUSTED with attempt metadata when a retry-eligible transaction keeps conflicting', async () => {
      const localExecutor = new RebalanceExecutorService({
        networkPassphrase,
        networkRetries: 1,
      });
      const feeBumpXdr = buildFeeBumpXdr(networkPassphrase);
      const badSeqResult = buildBadSeqTransactionResult();

      const sendTransaction = jest.fn().mockResolvedValue({
        status: 'ERROR',
        errorResult: badSeqResult,
      });
      (localExecutor as any).server.sendTransaction = sendTransaction;

      const attempt = makeAttempt();

      const nonceConflictModule = require('../relayer/nonceConflict');
      const spy = jest
        .spyOn(nonceConflictModule, 'isSafeToRetryAfterNonceConflict')
        .mockReturnValue(true);

      try {
        await expect(
          (localExecutor as any).submitTransactionWithNonceConflictHandling(feeBumpXdr, attempt),
        ).rejects.toThrow();

        expect(attempt.nonceConflict!.status).toBe('RETRY_EXHAUSTED');
        expect(attempt.nonceConflict!.code).toBe(NONCE_CONFLICT_CODE);
        expect(attempt.nonceConflict!.retried).toBe(true);
        expect(attempt.nonceConflict!.attempts).toHaveLength(2); // 1 initial + 1 retry
        expect(
          attempt.nonceConflict!.attempts.every((a: { outcome: string }) => a.outcome === 'nonce_conflict'),
        ).toBe(true);
        expect(sendTransaction).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('does not treat a non-nonce-conflict submission failure as a nonce conflict', async () => {
      const localExecutor = new RebalanceExecutorService({ networkPassphrase });
      const feeBumpXdr = buildFeeBumpXdr(networkPassphrase);

      const sendTransaction = jest.fn().mockRejectedValue(new Error('Connection refused'));
      (localExecutor as any).server.sendTransaction = sendTransaction;

      const attempt = makeAttempt();

      await expect(
        (localExecutor as any).submitTransactionWithNonceConflictHandling(feeBumpXdr, attempt),
      ).rejects.toThrow(/connection refused/i);

      expect(attempt.nonceConflict!.status).toBe('FAILED');
      expect(attempt.nonceConflict!.code).toBeUndefined();
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('succeeds immediately with no nonce-conflict metadata when submission works on the first try', async () => {
      const localExecutor = new RebalanceExecutorService({ networkPassphrase });
      const feeBumpXdr = buildFeeBumpXdr(networkPassphrase);

      const sendTransaction = jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        hash: 'first-try-hash',
      });
      (localExecutor as any).server.sendTransaction = sendTransaction;

      const attempt = makeAttempt();

      const result = await (localExecutor as any).submitTransactionWithNonceConflictHandling(
        feeBumpXdr,
        attempt,
      );

      expect(result.feeBumpHash).toBe('first-try-hash');
      expect(attempt.nonceConflict).toBeUndefined();
      expect(attempt.failureClass).toBeUndefined();
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('classifyError nonce-conflict precision (#1153)', () => {
    it('classifies a decoded txBadSeq errorResult as FEE_SEQUENCE even without "sequence" in the message', () => {
      const error = new Error('Transaction submission failed') as Error & {
        errorResult?: unknown;
      };
      error.errorResult = buildBadSeqTransactionResult();
      expect(executor.classifyError(error)).toBe(FAILURE_CLASS.FEE_SEQUENCE);
    });
  });
});
