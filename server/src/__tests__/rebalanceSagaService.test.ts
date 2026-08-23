import {
  RebalanceSagaService,
  SAGA_STATE,
  SAGA_PHASE,
  CHECKPOINT_STATUS,
  FAILURE_CLASS,
} from '../services/rebalanceSagaService';
import {
  executeRebalanceSaga,
  classifySagaError,
  recoverStuckSagas,
} from '../services/rebalanceSagaExecutor';
import { rebalanceExecutorService } from '../services/rebalanceExecutorService';
import { EXECUTION_TYPE, REBALANCE_STATUS } from '../queues/types';
import { RebalanceQueueEntryDTO } from '../services/rebalanceQueueService';

// Mock Prisma — the factory creates one shared instance inside its own closure
// and exposes it via __mockInstance so the test can configure the same object
// that the module-level `prisma` singleton in the service was assigned.
jest.mock('@prisma/client', () => {
  const instance = {
    rebalanceSaga: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    rebalanceSagaCheckpoint: {
      create: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    rebalanceSagaRetry: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
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
  (MockPrismaClient as any).__mockInstance = instance;
  return { PrismaClient: MockPrismaClient };
});

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

const baseSaga = () => ({
  id: 'saga-1',
  queueEntryId: 'entry-1',
  vaultId: 'vault-1',
  state: SAGA_STATE.PENDING,
  currentPhase: SAGA_PHASE.INIT,
  quoteKey: 'quote-key-1',
  approvalKey: 'approval-key-1',
  submissionKey: 'submission-key-1',
  confirmationKey: 'confirmation-key-1',
  snapshotKey: 'snapshot-key-1',
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
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
});

describe('RebalanceSagaService', () => {
  let service: RebalanceSagaService;
  let mockPrisma: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RebalanceSagaService();
    const { PrismaClient } = require('@prisma/client');
    mockPrisma = (PrismaClient as any).__mockInstance;
  });

  describe('createSaga', () => {
    it('creates a new saga with idempotency keys for all phases', async () => {
      mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(null);
      mockPrisma.rebalanceSaga.create.mockResolvedValueOnce(baseSaga());
      mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({ id: 'entry-1' });

      const saga = await service.createSaga('entry-1', 'vault-1');

      expect(saga.id).toBe('saga-1');
      expect(saga.state).toBe(SAGA_STATE.PENDING);
      expect(saga.currentPhase).toBe(SAGA_PHASE.INIT);
      expect(saga.quoteKey).toBeDefined();
      expect(saga.approvalKey).toBeDefined();
      expect(saga.submissionKey).toBeDefined();
      expect(saga.confirmationKey).toBeDefined();
      expect(saga.snapshotKey).toBeDefined();
      expect(mockPrisma.rebalanceSaga.create).toHaveBeenCalled();
      expect(mockPrisma.rebalanceQueueEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'entry-1' },
          data: expect.objectContaining({ sagaId: 'saga-1' }),
        }),
      );
    });

    it('returns existing saga if one already exists for the queue entry', async () => {
      mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(baseSaga());

      const saga = await service.createSaga('entry-1', 'vault-1');

      expect(saga.id).toBe('saga-1');
      expect(mockPrisma.rebalanceSaga.create).not.toHaveBeenCalled();
    });
  });

  describe('acquireLock', () => {
    it('acquires a lock when no other worker holds it', async () => {
      mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(baseSaga());
      mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
        ...baseSaga(),
        lockedBy: 'worker-1',
        lockedAt: new Date(),
        lockExpiresAt: new Date(Date.now() + 300000),
      });

      const result = await service.acquireLock('saga-1', 'worker-1');

      expect(result.acquired).toBe(true);
      expect(result.saga?.lockedBy).toBe('worker-1');
    });

    it('rejects lock acquisition when another worker holds an active lock', async () => {
      const lockedSaga = {
        ...baseSaga(),
        lockedBy: 'worker-2',
        lockedAt: new Date(),
        lockExpiresAt: new Date(Date.now() + 300000),
      };
      mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(lockedSaga);

      const result = await service.acquireLock('saga-1', 'worker-1');

      expect(result.acquired).toBe(false);
      expect(result.reason).toContain('Locked by worker-2');
    });

    it('steals an expired lock', async () => {
      const expiredSaga = {
        ...baseSaga(),
        lockedBy: 'worker-2',
        lockedAt: new Date(Date.now() - 600000),
        lockExpiresAt: new Date(Date.now() - 300000),
      };
      mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(expiredSaga);
      mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
        ...expiredSaga,
        lockedBy: 'worker-1',
        lockedAt: new Date(),
        lockExpiresAt: new Date(Date.now() + 300000),
      });

      const result = await service.acquireLock('saga-1', 'worker-1');

      expect(result.acquired).toBe(true);
      expect(result.saga?.lockedBy).toBe('worker-1');
    });
  });

  describe('recordCheckpoint', () => {
    it('records a checkpoint and updates saga phase', async () => {
      mockPrisma.rebalanceSagaCheckpoint.findUnique.mockResolvedValueOnce(null);
      mockPrisma.rebalanceSagaCheckpoint.create.mockResolvedValueOnce({
        id: 'cp-1',
        sagaId: 'saga-1',
        phase: SAGA_PHASE.QUOTE,
        idempotencyKey: 'quote-key-1',
        status: CHECKPOINT_STATUS.COMPLETED,
        payload: { viable: true },
        error: null,
        createdAt: new Date(),
        completedAt: new Date(),
      });
      mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
        ...baseSaga(),
        currentPhase: SAGA_PHASE.QUOTE,
        checkpoint: { phase: SAGA_PHASE.QUOTE },
      });

      const cp = await service.recordCheckpoint(
        'saga-1',
        SAGA_PHASE.QUOTE,
        'quote-key-1',
        { viable: true },
      );

      expect(cp.id).toBe('cp-1');
      expect(cp.status).toBe(CHECKPOINT_STATUS.COMPLETED);
      expect(mockPrisma.rebalanceSagaCheckpoint.create).toHaveBeenCalled();
    });

    it('does not re-create an existing checkpoint (idempotent)', async () => {
      mockPrisma.rebalanceSagaCheckpoint.findUnique.mockResolvedValueOnce({
        id: 'cp-1',
        sagaId: 'saga-1',
        phase: SAGA_PHASE.QUOTE,
        idempotencyKey: 'quote-key-1',
        status: CHECKPOINT_STATUS.COMPLETED,
        payload: null,
        error: null,
        createdAt: new Date(),
        completedAt: new Date(),
      });

      const cp = await service.recordCheckpoint(
        'saga-1',
        SAGA_PHASE.QUOTE,
        'quote-key-1',
      );

      expect(cp.id).toBe('cp-1');
      expect(mockPrisma.rebalanceSagaCheckpoint.create).not.toHaveBeenCalled();
    });
  });

  describe('transitionState', () => {
    it('transitions to a new state', async () => {
      mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
        ...baseSaga(),
        state: SAGA_STATE.SIMULATED,
      });

      const saga = await service.transitionState('saga-1', SAGA_STATE.SIMULATED);

      expect(saga.state).toBe(SAGA_STATE.SIMULATED);
    });

    it('sets completedAt for terminal states', async () => {
      mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
        ...baseSaga(),
        state: SAGA_STATE.CONFIRMED,
        completedAt: new Date(),
      });

      const saga = await service.transitionState('saga-1', SAGA_STATE.CONFIRMED, {
        transactionHash: '0xabc',
      });

      expect(saga.state).toBe(SAGA_STATE.CONFIRMED);
      expect(saga.completedAt).toBeDefined();
    });
  });

  describe('recordFailure', () => {
    it('increments failure count and allows retry within maxRetries', async () => {
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce(baseSaga());
      mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
        ...baseSaga(),
        failureCount: 1,
        failureClass: FAILURE_CLASS.TRANSIENT,
        state: SAGA_STATE.PENDING,
      });

      const result = await service.recordFailure(
        'saga-1',
        FAILURE_CLASS.TRANSIENT,
        'Network error',
      );

      expect(result.shouldRetry).toBe(true);
      expect(result.saga.failureCount).toBe(1);
      expect(result.saga.state).toBe(SAGA_STATE.PENDING);
    });

    it('marks as failed when maxRetries exceeded', async () => {
      const sagaWithFailures = {
        ...baseSaga(),
        failureCount: 3,
        maxRetries: 3,
      };
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce(sagaWithFailures);
      mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
        ...sagaWithFailures,
        failureCount: 4,
        state: SAGA_STATE.FAILED,
        completedAt: new Date(),
      });

      const result = await service.recordFailure(
        'saga-1',
        FAILURE_CLASS.TRANSIENT,
        'Still failing',
      );

      expect(result.shouldRetry).toBe(false);
      expect(result.saga.state).toBe(SAGA_STATE.FAILED);
    });
  });

  describe('resumeSaga', () => {
    it('returns QUOTE as resume phase for INIT', async () => {
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce(baseSaga());

      const result = await service.resumeSaga('saga-1');

      expect(result.resumeFromPhase).toBe(SAGA_PHASE.QUOTE);
    });

    it('returns APPROVAL as resume phase for QUOTE', async () => {
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseSaga(),
        currentPhase: SAGA_PHASE.QUOTE,
      });

      const result = await service.resumeSaga('saga-1');

      expect(result.resumeFromPhase).toBe(SAGA_PHASE.APPROVAL);
    });

    it('returns SUBMIT as resume phase for APPROVAL', async () => {
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseSaga(),
        currentPhase: SAGA_PHASE.APPROVAL,
      });

      const result = await service.resumeSaga('saga-1');

      expect(result.resumeFromPhase).toBe(SAGA_PHASE.SUBMIT);
    });

    it('returns CONFIRM as resume phase for SUBMIT', async () => {
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseSaga(),
        currentPhase: SAGA_PHASE.SUBMIT,
      });

      const result = await service.resumeSaga('saga-1');

      expect(result.resumeFromPhase).toBe(SAGA_PHASE.CONFIRM);
    });

    it('returns SNAPSHOT as resume phase for CONFIRM', async () => {
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseSaga(),
        currentPhase: SAGA_PHASE.CONFIRM,
      });

      const result = await service.resumeSaga('saga-1');

      expect(result.resumeFromPhase).toBe(SAGA_PHASE.SNAPSHOT);
    });

    it('returns COMPLETE as resume phase for SNAPSHOT', async () => {
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseSaga(),
        currentPhase: SAGA_PHASE.SNAPSHOT,
      });

      const result = await service.resumeSaga('saga-1');

      expect(result.resumeFromPhase).toBe(SAGA_PHASE.COMPLETE);
    });

    it('returns null resume phase for terminal states', async () => {
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseSaga(),
        state: SAGA_STATE.CONFIRMED,
      });

      const result = await service.resumeSaga('saga-1');

      expect(result.resumeFromPhase).toBeNull();
    });
  });

  describe('findStuckSagas', () => {
    it('finds sagas with expired locks or no lock', async () => {
      mockPrisma.rebalanceSaga.findMany.mockResolvedValueOnce([
        {
          ...baseSaga(),
          lockedBy: 'worker-1',
          lockExpiresAt: new Date(Date.now() - 1000),
        },
        {
          ...baseSaga(),
          id: 'saga-2',
          lockedBy: null,
        },
      ]);

      const stuck = await service.findStuckSagas();

      expect(stuck).toHaveLength(2);
      expect(mockPrisma.rebalanceSaga.findMany).toHaveBeenCalled();
    });
  });

  describe('resolveManualReview', () => {
    it('resolves review with retry decision', async () => {
      const reviewSaga = {
        ...baseSaga(),
        state: SAGA_STATE.REQUIRES_MANUAL_REVIEW,
        reviewRequired: true,
      };
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce(reviewSaga);
      mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
        ...reviewSaga,
        state: SAGA_STATE.PENDING,
        reviewedAt: new Date(),
        reviewedBy: 'admin-1',
        reviewRequired: false,
      });
      mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({
        id: 'entry-1',
        status: REBALANCE_STATUS.PENDING,
      });

      const saga = await service.resolveManualReview('saga-1', 'retry', 'admin-1');

      expect(saga.state).toBe(SAGA_STATE.PENDING);
      expect(saga.reviewRequired).toBe(false);
      expect(saga.reviewedBy).toBe('admin-1');
      // Queue entry must return to PENDING so the processor picks it back up.
      expect(mockPrisma.rebalanceQueueEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'entry-1' },
          data: expect.objectContaining({ status: 'PENDING' }),
        }),
      );
    });

    it('resolves review with cancel decision', async () => {
      const reviewSaga = {
        ...baseSaga(),
        state: SAGA_STATE.REQUIRES_MANUAL_REVIEW,
        reviewRequired: true,
      };
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce(reviewSaga);
      mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
        ...reviewSaga,
        state: SAGA_STATE.CANCELLED,
        reviewRequired: false,
        completedAt: new Date(),
      });
      mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({
        id: 'entry-1',
        status: 'CANCELLED',
      });

      const saga = await service.resolveManualReview('saga-1', 'cancel', 'admin-1');

      expect(saga.state).toBe(SAGA_STATE.CANCELLED);
      // Queue entry must be terminal CANCELLED so it stays out of the retry pool.
      expect(mockPrisma.rebalanceQueueEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'entry-1' },
          data: expect.objectContaining({ status: 'CANCELLED' }),
        }),
      );
    });

    it('throws if saga is not in requires_manual_review state', async () => {
      mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce(baseSaga());

      await expect(
        service.resolveManualReview('saga-1', 'retry', 'admin-1'),
      ).rejects.toThrow(/not in requires_manual_review/);
    });
  });

  describe('terminal queue-entry sync', () => {
    it('marks queue entry COMPLETED when saga reaches confirmed', async () => {
      const confirmedSaga = {
        ...baseSaga(),
        state: SAGA_STATE.CONFIRMED,
        currentPhase: SAGA_PHASE.COMPLETE,
        transactionHash: '0xabc',
      };
      mockPrisma.rebalanceSaga.update.mockResolvedValueOnce(confirmedSaga);
      mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({
        id: 'entry-1',
        status: REBALANCE_STATUS.COMPLETED,
      });

      const saga = await service.transitionState('saga-1', SAGA_STATE.CONFIRMED, {
        transactionHash: '0xabc',
      });

      expect(saga.state).toBe(SAGA_STATE.CONFIRMED);
      // Queue entry synced to COMPLETED so it is visible as done.
      expect(mockPrisma.rebalanceQueueEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'entry-1' },
          data: expect.objectContaining({
            status: REBALANCE_STATUS.COMPLETED,
            lastError: null,
          }),
        }),
      );
    });

    it('marks queue entry FAILED with reason when saga requires manual review', async () => {
      const reviewSaga = {
        ...baseSaga(),
        state: SAGA_STATE.REQUIRES_MANUAL_REVIEW,
        reviewRequired: true,
        reviewReason: 'Unrecoverable failure: Slippage breach',
      };
      mockPrisma.rebalanceSaga.update.mockResolvedValueOnce(reviewSaga);
      mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({
        id: 'entry-1',
        status: REBALANCE_STATUS.FAILED,
      });

      const saga = await service.requireManualReview(
        'saga-1',
        'Unrecoverable failure: Slippage breach',
      );

      expect(saga.state).toBe(SAGA_STATE.REQUIRES_MANUAL_REVIEW);
      // Failure reason is pushed to the queue so it does not disappear.
      expect(mockPrisma.rebalanceQueueEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'entry-1' },
          data: expect.objectContaining({
            status: REBALANCE_STATUS.FAILED,
            lastError: 'Unrecoverable failure: Slippage breach',
          }),
        }),
      );
    });
  });
});

describe('classifySagaError', () => {
  it('classifies expired errors as STALE_INTENT', () => {
    expect(classifySagaError(new Error('Intent expired'))).toBe(FAILURE_CLASS.STALE_INTENT);
  });

  it('classifies constraint errors as CONSTRAINT', () => {
    expect(classifySagaError(new Error('Slippage breach'))).toBe(FAILURE_CLASS.CONSTRAINT);
    expect(classifySagaError(new Error('Dry-run failed'))).toBe(FAILURE_CLASS.CONSTRAINT);
  });

  it('classifies fee/sequence errors as FEE_SEQUENCE', () => {
    expect(classifySagaError(new Error('Invalid sequence number'))).toBe(FAILURE_CLASS.FEE_SEQUENCE);
  });

  it('classifies malformed XDR as PERMANENT', () => {
    expect(classifySagaError(new Error('Malformed XDR'))).toBe(FAILURE_CLASS.PERMANENT);
  });

  it('classifies duplicate submissions as PERMANENT', () => {
    expect(classifySagaError(new Error('Duplicate submission detected'))).toBe(FAILURE_CLASS.PERMANENT);
  });

  it('classifies unknown errors as TRANSIENT', () => {
    expect(classifySagaError(new Error('Connection refused'))).toBe(FAILURE_CLASS.TRANSIENT);
  });
});

describe('executeRebalanceSaga', () => {
  let mockPrisma: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { PrismaClient } = require('@prisma/client');
    mockPrisma = (PrismaClient as any).__mockInstance;

    // Mock executor methods to avoid real network calls
    jest.spyOn(rebalanceExecutorService, 'dryRun').mockResolvedValue({
      viable: true,
      estimatedFill: 100,
    });
    jest.spyOn(rebalanceExecutorService, 'execute').mockResolvedValue({
      queueEntryId: 'entry-1',
      totalExecuted: 100,
      expectedAmount: 100,
      filledPercentage: 100,
      transactionHash: '0xabc',
      executionDetails: {
        status: 'confirmed',
        feeBumpHash: 'fee-bump-1',
        timestamp: new Date(),
      },
    });
    jest.spyOn(rebalanceExecutorService, 'confirmTransaction').mockResolvedValue(true);
  });

  it('executes a full saga successfully through all phases', async () => {
    const entry = baseEntry();

    // createSaga
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(null);
    mockPrisma.rebalanceSaga.create.mockResolvedValueOnce(baseSaga());
    mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({});

    // acquireLock
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(baseSaga());
    mockPrisma.rebalanceSaga.update.mockResolvedValue({
      ...baseSaga(),
      lockedBy: 'worker-1',
      lockedAt: new Date(),
      lockExpiresAt: new Date(Date.now() + 300000),
    });

    // resumeSaga
    mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce(baseSaga());

    // QUOTE checkpoint
    mockPrisma.rebalanceSagaCheckpoint.findUnique.mockResolvedValue(null);
    mockPrisma.rebalanceSagaCheckpoint.create.mockResolvedValue({
      id: 'cp-1',
      sagaId: 'saga-1',
      phase: SAGA_PHASE.QUOTE,
      idempotencyKey: 'quote-key-1',
      status: CHECKPOINT_STATUS.COMPLETED,
      payload: { viable: true },
      error: null,
      createdAt: new Date(),
      completedAt: new Date(),
    });

    // All subsequent rebalanceSaga.update calls return the confirmed saga
    mockPrisma.rebalanceSaga.update.mockResolvedValue({
      ...baseSaga(),
      state: SAGA_STATE.CONFIRMED,
      currentPhase: SAGA_PHASE.COMPLETE,
      transactionHash: '0xabc',
    });

    // getSagaByQueueEntry
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce({
      ...baseSaga(),
      state: SAGA_STATE.CONFIRMED,
      currentPhase: SAGA_PHASE.COMPLETE,
      transactionHash: '0xabc',
    });

    // releaseLock
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValue({
      ...baseSaga(),
      lockedBy: 'worker-1',
    });

    const outcome = await executeRebalanceSaga(entry, { workerId: 'worker-1' });

    expect(outcome.completed).toBe(true);
    expect(outcome.saga.state).toBe(SAGA_STATE.CONFIRMED);
  });

  it('handles simulated timeout during QUOTE phase', async () => {
    const entry = baseEntry();

    // createSaga
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(null);
    mockPrisma.rebalanceSaga.create.mockResolvedValueOnce(baseSaga());
    mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({});

    // acquireLock
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(baseSaga());
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...baseSaga(),
      lockedBy: 'worker-1',
      lockedAt: new Date(),
      lockExpiresAt: new Date(Date.now() + 300000),
    });

    // resumeSaga
    mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce(baseSaga());

    // recordRetry
    mockPrisma.rebalanceSagaRetry.create.mockResolvedValueOnce({
      id: 'retry-1',
      sagaId: 'saga-1',
      attemptNumber: 1,
      phase: SAGA_PHASE.INIT,
      reason: 'Simulated timeout during QUOTE phase',
      failureClass: FAILURE_CLASS.TRANSIENT,
      error: 'Simulated timeout during QUOTE phase',
      createdAt: new Date(),
    });

    // recordFailure
    mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce(baseSaga());
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...baseSaga(),
      failureCount: 1,
      failureClass: FAILURE_CLASS.TRANSIENT,
      failureReason: 'Simulated timeout during QUOTE phase',
      state: SAGA_STATE.PENDING,
    });

    // releaseLock
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce({
      ...baseSaga(),
      lockedBy: 'worker-1',
    });
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...baseSaga(),
      lockedBy: null,
    });

    const outcome = await executeRebalanceSaga(entry, {
      workerId: 'worker-1',
      simulateTimeoutAt: SAGA_PHASE.QUOTE,
    });

    expect(outcome.completed).toBe(false);
    expect(outcome.error).toContain('Simulated timeout');
  });

  it('prevents duplicate execution when lock is held by another worker', async () => {
    const entry = baseEntry();

    // createSaga
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(null);
    mockPrisma.rebalanceSaga.create.mockResolvedValueOnce(baseSaga());
    mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({});

    // acquireLock — already locked by another worker
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce({
      ...baseSaga(),
      lockedBy: 'worker-2',
      lockedAt: new Date(),
      lockExpiresAt: new Date(Date.now() + 300000),
    });

    const outcome = await executeRebalanceSaga(entry, { workerId: 'worker-1' });

    expect(outcome.completed).toBe(false);
    expect(outcome.error).toContain('Locked by worker-2');
  });

  it('handles duplicate submission detection', async () => {
    const entry = baseEntry();

    // createSaga
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(null);
    mockPrisma.rebalanceSaga.create.mockResolvedValueOnce(baseSaga());
    mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({});

    // acquireLock
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(baseSaga());
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...baseSaga(),
      lockedBy: 'worker-1',
      lockedAt: new Date(),
      lockExpiresAt: new Date(Date.now() + 300000),
    });

    // resumeSaga
    mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce(baseSaga());

    // QUOTE checkpoint
    mockPrisma.rebalanceSagaCheckpoint.findUnique.mockResolvedValueOnce(null);
    mockPrisma.rebalanceSagaCheckpoint.create.mockResolvedValueOnce({
      id: 'cp-1',
      sagaId: 'saga-1',
      phase: SAGA_PHASE.QUOTE,
      idempotencyKey: 'quote-key-1',
      status: CHECKPOINT_STATUS.COMPLETED,
      payload: { viable: true },
      error: null,
      createdAt: new Date(),
      completedAt: new Date(),
    });
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...baseSaga(),
      state: SAGA_STATE.SIMULATED,
      currentPhase: SAGA_PHASE.QUOTE,
    });

    // APPROVAL checkpoint
    mockPrisma.rebalanceSagaCheckpoint.findUnique.mockResolvedValueOnce(null);
    mockPrisma.rebalanceSagaCheckpoint.create.mockResolvedValueOnce({
      id: 'cp-2',
      sagaId: 'saga-1',
      phase: SAGA_PHASE.APPROVAL,
      idempotencyKey: 'approval-key-1',
      status: CHECKPOINT_STATUS.COMPLETED,
      payload: { approved: true },
      error: null,
      createdAt: new Date(),
      completedAt: new Date(),
    });
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...baseSaga(),
      state: SAGA_STATE.SIMULATED,
      currentPhase: SAGA_PHASE.APPROVAL,
    });

    // recordRetry
    mockPrisma.rebalanceSagaRetry.create.mockResolvedValueOnce({
      id: 'retry-1',
      sagaId: 'saga-1',
      attemptNumber: 1,
      phase: SAGA_PHASE.APPROVAL,
      reason: 'Simulated duplicate submission detected',
      failureClass: FAILURE_CLASS.PERMANENT,
      error: 'Simulated duplicate submission detected',
      createdAt: new Date(),
    });

    // recordFailure
    mockPrisma.rebalanceSaga.findUniqueOrThrow.mockResolvedValueOnce(baseSaga());
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...baseSaga(),
      failureCount: 1,
      failureClass: FAILURE_CLASS.PERMANENT,
      failureReason: 'Simulated duplicate submission detected',
      state: SAGA_STATE.PENDING,
    });

    // releaseLock
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce({
      ...baseSaga(),
      lockedBy: 'worker-1',
    });
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...baseSaga(),
      lockedBy: null,
    });

    const outcome = await executeRebalanceSaga(entry, {
      workerId: 'worker-1',
      simulateDuplicate: true,
    });

    expect(outcome.completed).toBe(false);
    expect(outcome.error).toContain('duplicate');
  });
});

describe('recoverStuckSagas', () => {
  let mockPrisma: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { PrismaClient } = require('@prisma/client');
    mockPrisma = (PrismaClient as any).__mockInstance;

    // Default: confirmTransaction resolves false (tx not found / still pending)
    jest.spyOn(rebalanceExecutorService, 'confirmTransaction').mockResolvedValue(false);
  });

  it('confirms a SUBMITTED saga whose persisted hash landed on-chain', async () => {
    const submittedSaga = {
      ...baseSaga(),
      state: SAGA_STATE.SUBMITTED,
      currentPhase: SAGA_PHASE.SUBMIT,
      transactionHash: '0xlanded',
      lockedBy: 'worker-1',
      lockedAt: new Date(Date.now() - 600000),
      lockExpiresAt: new Date(Date.now() - 300000),
    };
    (rebalanceExecutorService.confirmTransaction as jest.Mock).mockResolvedValue(true);

    // findStuckSagas
    mockPrisma.rebalanceSaga.findMany.mockResolvedValueOnce([submittedSaga]);

    // acquireLock: findUnique + update (lockedBy worker-2 -> steal)
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(submittedSaga);
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...submittedSaga,
      lockedBy: 'recovery-worker',
    });

    // transitionState -> rebalanceSaga.update (confirmed)
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...submittedSaga,
      state: SAGA_STATE.CONFIRMED,
    });

    // releaseLock -> findUnique + update
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce({
      ...submittedSaga,
      state: SAGA_STATE.CONFIRMED,
      lockedBy: 'recovery-worker',
    });
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...submittedSaga,
      lockedBy: null,
    });

    const result = await recoverStuckSagas('recovery-worker');

    expect(rebalanceExecutorService.confirmTransaction).toHaveBeenCalledWith('0xlanded');
    expect(result.recovered).toBe(1);
    expect(mockPrisma.rebalanceSaga.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'saga-1' },
        data: expect.objectContaining({ state: SAGA_STATE.CONFIRMED }),
      }),
    );
  });

  it('does NOT reset a SUBMITTED saga with a persisted hash that is not yet confirmed', async () => {
    const submittedSaga = {
      ...baseSaga(),
      state: SAGA_STATE.SUBMITTED,
      currentPhase: SAGA_PHASE.SUBMIT,
      transactionHash: '0xpending',
      lockedBy: 'worker-1',
      lockedAt: new Date(Date.now() - 600000),
      lockExpiresAt: new Date(Date.now() - 300000),
    };
    (rebalanceExecutorService.confirmTransaction as jest.Mock).mockResolvedValue(false);

    // findStuckSagas
    mockPrisma.rebalanceSaga.findMany.mockResolvedValueOnce([submittedSaga]);

    // acquireLock: findUnique + update
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(submittedSaga);
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...submittedSaga,
      lockedBy: 'recovery-worker',
    });

    // releaseLock -> findUnique + update
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce({
      ...submittedSaga,
      lockedBy: 'recovery-worker',
    });
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...submittedSaga,
      lockedBy: null,
    });

    const result = await recoverStuckSagas('recovery-worker');

    // Critical: saga must NOT be reset to PENDING — that would trigger a
    // duplicate submission on retry. It stays SUBMITTED so the executor can
    // resume from CONFIRM and re-poll the same hash.
    expect(result.recovered).toBe(0);
    expect(mockPrisma.rebalanceSaga.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'saga-1' },
        data: expect.objectContaining({ state: SAGA_STATE.PENDING }),
      }),
    );
  });

  it('resets a pre-submission saga (PENDING, no hash) to PENDING for retry', async () => {
    const pendingSaga = {
      ...baseSaga(),
      state: SAGA_STATE.PENDING,
      currentPhase: SAGA_PHASE.INIT,
      transactionHash: null,
      lockedBy: 'worker-1',
      lockedAt: new Date(Date.now() - 600000),
      lockExpiresAt: new Date(Date.now() - 300000),
    };

    // findStuckSagas
    mockPrisma.rebalanceSaga.findMany.mockResolvedValueOnce([pendingSaga]);

    // acquireLock -> findUnique + lock update
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(pendingSaga);
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...pendingSaga,
      lockedBy: 'recovery-worker',
    });

    // reset to PENDING via transitionState
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...pendingSaga,
      state: SAGA_STATE.PENDING,
    });

    // releaseLock -> findUnique + update
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce({
      ...pendingSaga,
      lockedBy: 'recovery-worker',
    });
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...pendingSaga,
      lockedBy: null,
    });

    const result = await recoverStuckSagas('recovery-worker');

    expect(result.recovered).toBe(1);
    expect(mockPrisma.rebalanceSaga.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'saga-1' },
        data: expect.objectContaining({ state: SAGA_STATE.PENDING }),
      }),
    );
  });

  it('does NOT reset a SIMULATED saga that somehow holds a transaction hash (safety)', async () => {
    const simulatedWithHash = {
      ...baseSaga(),
      state: SAGA_STATE.SIMULATED,
      currentPhase: SAGA_PHASE.APPROVAL,
      transactionHash: '0xunexpected',
      lockedBy: 'worker-1',
      lockedAt: new Date(Date.now() - 600000),
      lockExpiresAt: new Date(Date.now() - 300000),
    };

    mockPrisma.rebalanceSaga.findMany.mockResolvedValueOnce([simulatedWithHash]);

    // acquireLock
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce(simulatedWithHash);
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...simulatedWithHash,
      lockedBy: 'recovery-worker',
    });

    // releaseLock
    mockPrisma.rebalanceSaga.findUnique.mockResolvedValueOnce({
      ...simulatedWithHash,
      lockedBy: 'recovery-worker',
    });
    mockPrisma.rebalanceSaga.update.mockResolvedValueOnce({
      ...simulatedWithHash,
      lockedBy: null,
    });

    const result = await recoverStuckSagas('recovery-worker');

    // Any saga with a hash is treated conservatively — never re-run/re-submit.
    expect(result.recovered).toBe(0);
  });
});
