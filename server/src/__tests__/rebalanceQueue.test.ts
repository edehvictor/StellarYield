import { EXECUTION_TYPE, REBALANCE_STATUS } from '../queues/types';
import { RebalanceQueueService } from '../services/rebalanceQueueService';

// Mock Prisma
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
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
  })),
}));

describe('RebalanceQueueService', () => {
  let service: RebalanceQueueService;
  let mockPrisma: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RebalanceQueueService();
    mockPrisma = require('@prisma/client').PrismaClient();
  });

  describe('enqueueRebalance', () => {
    it('should enqueue a new rebalance request', async () => {
      const vaultId = 'vault-123';
      const targetAllocations = { token1: 50, token2: 30, token3: 20 };
      const currentAllocations = { token1: 60, token2: 20, token3: 20 };
      const executionStrategy = { slippage: 0.5 };

      mockPrisma.rebalanceQueueEntry.findUnique.mockResolvedValue(null);
      mockPrisma.rebalanceQueueEntry.create.mockResolvedValue({
        id: 'queue-1',
        vaultId,
        status: REBALANCE_STATUS.PENDING,
        executionType: EXECUTION_TYPE.FULL,
        targetAllocations,
        currentAllocations,
        executionStrategy,
        partiallyExecuted: false,
        partialFillAmount: 0,
        intentHash: expect.any(String),
        intentValidUntil: expect.any(Date),
        maxRetries: 3,
        attemptCount: 0,
        nextRetryAt: null,
        deferredUntil: null,
        followUpEntryId: null,
        lastError: null,
        triggeredBy: null,
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.enqueueRebalance(
        vaultId,
        targetAllocations,
        currentAllocations,
        executionStrategy,
      );

      expect(result).toBeDefined();
      expect(result.status).toBe(REBALANCE_STATUS.PENDING);
      expect(result.attemptCount).toBe(0);
      expect(mockPrisma.rebalanceQueueEntry.create).toHaveBeenCalled();
    });

    it('should prevent duplicate intents for same vault', async () => {
      const vaultId = 'vault-123';
      const targetAllocations = { token1: 50, token2: 30, token3: 20 };

      mockPrisma.rebalanceQueueEntry.findUnique.mockResolvedValue({
        id: 'queue-1',
        status: REBALANCE_STATUS.PENDING,
      });

      await expect(
        service.enqueueRebalance(
          vaultId,
          targetAllocations,
          {},
          {},
        ),
      ).rejects.toThrow('Duplicate rebalance intent');
    });

    it('should allow re-queueing if previous attempt is completed', async () => {
      const vaultId = 'vault-123';
      const targetAllocations = { token1: 50, token2: 30, token3: 20 };

      // First call - no existing entry
      mockPrisma.rebalanceQueueEntry.findUnique.mockResolvedValueOnce(null);
      mockPrisma.rebalanceQueueEntry.findUnique.mockResolvedValueOnce({
        id: 'queue-1',
        status: REBALANCE_STATUS.COMPLETED,
      });

      mockPrisma.rebalanceQueueEntry.create.mockResolvedValueOnce({
        id: 'queue-1',
        vaultId,
        status: REBALANCE_STATUS.PENDING,
        executionType: EXECUTION_TYPE.FULL,
        targetAllocations,
        currentAllocations: {},
        executionStrategy: {},
        partiallyExecuted: false,
        partialFillAmount: 0,
        intentHash: expect.any(String),
        intentValidUntil: expect.any(Date),
        maxRetries: 3,
        attemptCount: 0,
        nextRetryAt: null,
        deferredUntil: null,
        followUpEntryId: null,
        lastError: null,
        triggeredBy: null,
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.enqueueRebalance(
        vaultId,
        targetAllocations,
        {},
        {},
      );

      expect(result.status).toBe(REBALANCE_STATUS.PENDING);
    });
  });

  describe('Retry Mechanism', () => {
    it('should record failed attempt and schedule retry', async () => {
      const queueEntryId = 'queue-1';
      const error = 'Execution failed: insufficient liquidity';

      mockPrisma.rebalanceQueueEntry.findUniqueOrThrow.mockResolvedValue({
        id: queueEntryId,
        attemptCount: 0,
        intentValidUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      mockPrisma.rebalanceQueueEntry.update.mockResolvedValue({
        id: queueEntryId,
        status: REBALANCE_STATUS.PENDING,
        attemptCount: 1,
        nextRetryAt: expect.any(Date),
        lastError: error,
      });

      const result = await service.recordFailedAttempt(queueEntryId, error);

      expect(result.attemptCount).toBe(1);
      expect(result.status).toBe(REBALANCE_STATUS.PENDING);
      expect(mockPrisma.rebalanceQueueEntry.update).toHaveBeenCalled();
    });

    it('should mark as failed after max retries exceeded', async () => {
      const queueEntryId = 'queue-1';
      const maxRetries = 3;

      mockPrisma.rebalanceQueueEntry.findUniqueOrThrow.mockResolvedValue({
        id: queueEntryId,
        attemptCount: maxRetries,
        intentValidUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      mockPrisma.rebalanceQueueEntry.update.mockResolvedValue({
        id: queueEntryId,
        status: REBALANCE_STATUS.FAILED,
        attemptCount: maxRetries + 1,
        nextRetryAt: null,
        completedAt: expect.any(Date),
      });

      const result = await service.recordFailedAttempt(
        queueEntryId,
        'Still failing',
        { maxRetries },
      );

      expect(result.status).toBe(REBALANCE_STATUS.FAILED);
      expect(result.nextRetryAt).toBeNull();
    });

    it('should reject stale intents (replay prevention)', async () => {
      const queueEntryId = 'queue-1';
      const expiredDate = new Date(Date.now() - 1000); // 1 second in past

      mockPrisma.rebalanceQueueEntry.findUniqueOrThrow.mockResolvedValue({
        id: queueEntryId,
        attemptCount: 0,
        intentValidUntil: expiredDate,
      });

      mockPrisma.rebalanceQueueEntry.update.mockResolvedValue({
        id: queueEntryId,
        status: REBALANCE_STATUS.FAILED,
        lastError: 'Intent expired - replay prevention triggered',
        completedAt: expect.any(Date),
      });

      const result = await service.recordFailedAttempt(queueEntryId, 'Stale intent');

      expect(result.status).toBe(REBALANCE_STATUS.FAILED);
      expect(result.lastError).toContain('Intent expired');
    });
  });

  describe('Partial Execution', () => {
    it('should record partial fill and mark as partial', async () => {
      const queueEntryId = 'queue-1';
      const executionResult = {
        queueEntryId,
        totalExecuted: 60,
        expectedAmount: 100,
        filledPercentage: 60,
        transactionHash: '0xabc123',
        executionDetails: { status: 'partial' },
      };

      mockPrisma.rebalanceQueueEntry.findUniqueOrThrow.mockResolvedValue({
        id: queueEntryId,
        vaultId: 'vault-1',
        currentAllocations: { token1: 100, token2: 100 },
        targetAllocations: { token1: 50, token2: 50 },
        executionStrategy: {},
        attemptCount: 1,
        intentValidUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
        maxRetries: 3,
      });

      mockPrisma.rebalanceQueueEntry.update.mockResolvedValue({
        id: queueEntryId,
        status: REBALANCE_STATUS.PARTIAL,
        partiallyExecuted: true,
        partialFillAmount: 60,
        followUpEntryId: 'queue-2',
      });

      const result = await service.recordPartialExecution(queueEntryId, executionResult, {
        deferralThreshold: 75,
      });

      expect(result.status).toBe(REBALANCE_STATUS.PARTIAL);
      expect(result.partiallyExecuted).toBe(true);
      expect(mockPrisma.rebalanceHistory.create).toHaveBeenCalled();
    });

    it('should create deferred follow-up for partial execution', async () => {
      const queueEntryId = 'queue-1';
      const executionResult = {
        queueEntryId,
        totalExecuted: 70,
        expectedAmount: 100,
        filledPercentage: 70,
        executionDetails: {},
      };

      mockPrisma.rebalanceQueueEntry.findUniqueOrThrow.mockResolvedValue({
        id: queueEntryId,
        vaultId: 'vault-1',
        currentAllocations: { token1: 100 },
        targetAllocations: { token1: 50 },
        executionStrategy: {},
        attemptCount: 1,
        intentValidUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
        maxRetries: 3,
      });

      mockPrisma.rebalanceQueueEntry.update.mockResolvedValue({
        id: queueEntryId,
        status: REBALANCE_STATUS.PARTIAL,
        followUpEntryId: 'queue-2',
      });

      const result = await service.recordPartialExecution(queueEntryId, executionResult);

      expect(result.followUpEntryId).toBe('queue-2');
    });
  });

  describe('Queue Status and Retrieval', () => {
    it('should get queue status for a vault', async () => {
      mockPrisma.rebalanceQueueEntry.count
        .mockResolvedValueOnce(5) // pending
        .mockResolvedValueOnce(2) // processing
        .mockResolvedValueOnce(1) // partial
        .mockResolvedValueOnce(3) // failed
        .mockResolvedValueOnce(2); // deferred

      const status = await service.getQueueStatus('vault-1');

      expect(status.pendingCount).toBe(5);
      expect(status.processingCount).toBe(2);
      expect(status.partialCount).toBe(1);
      expect(status.failedCount).toBe(3);
      expect(status.deferredCount).toBe(2);
    });

    it('should get pending retries', async () => {
      const now = new Date();
      mockPrisma.rebalanceQueueEntry.findMany.mockResolvedValue([
        {
          id: 'queue-1',
          status: REBALANCE_STATUS.PENDING,
          attemptCount: 1,
          nextRetryAt: new Date(now.getTime() - 10000),
        },
      ]);

      const retries = await service.getPendingRetries();

      expect(retries).toHaveLength(1);
      expect(mockPrisma.rebalanceQueueEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: REBALANCE_STATUS.PENDING,
          }),
        }),
      );
    });

    it('should get deferred entries', async () => {
      const now = new Date();
      mockPrisma.rebalanceQueueEntry.findMany.mockResolvedValue([
        {
          id: 'queue-1',
          status: REBALANCE_STATUS.PENDING,
          executionType: EXECUTION_TYPE.DEFERRED,
          deferredUntil: new Date(now.getTime() - 10000),
        },
      ]);

      const deferred = await service.getDeferredEntries();

      expect(deferred).toHaveLength(1);
      expect(mockPrisma.rebalanceQueueEntry.findMany).toHaveBeenCalled();
    });

    it('should get execution history', async () => {
      mockPrisma.rebalanceHistory.findMany.mockResolvedValue([
        {
          id: 'history-1',
          vaultId: 'vault-1',
          executionType: EXECUTION_TYPE.FULL,
          filledPercentage: 100,
          totalExecuted: 100,
          completedAt: new Date(),
          transactionHash: '0xabc123',
        },
      ]);

      const history = await service.getExecutionHistory('vault-1');

      expect(history).toHaveLength(1);
      expect(history[0].filledPercentage).toBe(100);
    });
  });

  describe('Conflict Detection', () => {
    it('should detect conflicting entries', async () => {
      const targetAllocations = { token1: 50, token2: 50 };

      mockPrisma.rebalanceQueueEntry.findMany.mockResolvedValue([
        {
          targetAllocations: { token1: 60, token2: 40 },
        },
      ]);

      const noConflict = await service.validateNoConflictingEntries(
        'vault-1',
        targetAllocations,
      );

      expect(noConflict).toBe(false);
    });

    it('should allow non-conflicting entries', async () => {
      const targetAllocations = { token1: 50, token2: 50 };

      mockPrisma.rebalanceQueueEntry.findMany.mockResolvedValue([]);

      const noConflict = await service.validateNoConflictingEntries(
        'vault-1',
        targetAllocations,
      );

      expect(noConflict).toBe(true);
    });
  });

  describe('Entry Completion', () => {
    it('should mark entry as completed', async () => {
      mockPrisma.rebalanceQueueEntry.findUniqueOrThrow.mockResolvedValue({
        id: 'queue-1',
        vaultId: 'vault-1',
      });

      mockPrisma.rebalanceQueueEntry.update.mockResolvedValue({
        id: 'queue-1',
        status: REBALANCE_STATUS.COMPLETED,
        completedAt: expect.any(Date),
      });

      const result = await service.markAsCompleted('queue-1', '0xabc123');

      expect(result.status).toBe(REBALANCE_STATUS.COMPLETED);
      expect(result.completedAt).toBeDefined();
      expect(mockPrisma.rebalanceHistory.create).toHaveBeenCalled();
    });

    it('should cancel entry with reason', async () => {
      mockPrisma.rebalanceQueueEntry.update.mockResolvedValue({
        id: 'queue-1',
        status: REBALANCE_STATUS.CANCELLED,
        lastError: 'User requested cancellation',
        completedAt: expect.any(Date),
      });

      const result = await service.cancelEntry('queue-1', 'User requested cancellation');

      expect(result.status).toBe(REBALANCE_STATUS.CANCELLED);
    });
  });
});
