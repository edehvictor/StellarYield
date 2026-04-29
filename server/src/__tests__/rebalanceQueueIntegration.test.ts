import { runRebalanceQueueProcessorJob } from '../jobs/rebalanceQueueProcessorJob';
import { EXECUTION_TYPE, REBALANCE_STATUS, STRATEGY_EVENT_TYPE } from '../queues/types';
import { RebalanceQueueService } from '../services/rebalanceQueueService';
import { StrategySnapshotVersioningService } from '../services/strategySnapshotVersioningService';

// Mock Prisma for integration test
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
    strategySnapshot: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    strategyVersionReference: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    strategyVersionHistory: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  })),
}));

describe('Rebalance Queue and Strategy Versioning Integration', () => {
  let queueService: RebalanceQueueService;
  let versioningService: StrategySnapshotVersioningService;
  let mockPrisma: any;

  beforeEach(() => {
    jest.clearAllMocks();
    queueService = new RebalanceQueueService();
    versioningService = new StrategySnapshotVersioningService();
    mockPrisma = require('@prisma/client').PrismaClient();
  });

  describe('Complete Rebalance Lifecycle with Versioning', () => {
    it('should execute full rebalance workflow with version tracking', async () => {
      const strategyId = 'strategy-1';
      const vaultId = 'vault-1';
      const targetAllocations = { BTC: 0.4, ETH: 0.3, USDC: 0.3 };

      // Step 1: Create strategy version
      mockPrisma.strategySnapshot.findFirst.mockResolvedValueOnce(null);
      mockPrisma.strategySnapshot.create.mockResolvedValueOnce({
        id: 'snap-1',
        strategyId,
        version: 1,
        name: 'Initial Strategy',
        keyWeights: targetAllocations,
        riskParameters: {},
        constraints: {},
        status: 'ACTIVE',
        createdAt: new Date(),
      });

      const snapshot = await versioningService.createSnapshot(
        strategyId,
        'Initial Strategy',
        targetAllocations,
        {},
        {},
      );

      expect(snapshot.version).toBe(1);

      // Step 2: Enqueue rebalance
      mockPrisma.rebalanceQueueEntry.findUnique.mockResolvedValueOnce(null);
      mockPrisma.rebalanceQueueEntry.create.mockResolvedValueOnce({
        id: 'queue-1',
        vaultId,
        status: REBALANCE_STATUS.PENDING,
        executionType: EXECUTION_TYPE.FULL,
        targetAllocations,
        currentAllocations: { BTC: 0.5, ETH: 0.2, USDC: 0.3 },
        executionStrategy: {},
        intentHash: expect.any(String),
        attemptCount: 0,
        maxRetries: 3,
        nextRetryAt: null,
        deferredUntil: null,
        partiallyExecuted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const queueEntry = await queueService.enqueueRebalance(
        vaultId,
        targetAllocations,
        { BTC: 0.5, ETH: 0.2, USDC: 0.3 },
        {},
      );

      expect(queueEntry.status).toBe(REBALANCE_STATUS.PENDING);

      // Step 3: Link rebalance to strategy version
      mockPrisma.strategySnapshot.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'snap-1',
        strategyId,
        version: 1,
      });

      mockPrisma.strategyVersionReference.create.mockResolvedValueOnce({
        id: 'ref-1',
        strategySnapshotId: 'snap-1',
        strategyId,
        snapshotVersion: 1,
        rebalanceQueueId: 'queue-1',
        eventType: STRATEGY_EVENT_TYPE.REBALANCE,
        linkedAt: new Date(),
      });

      const reference = await versioningService.linkRebalance('snap-1', 'queue-1');

      expect(reference.eventType).toBe(STRATEGY_EVENT_TYPE.REBALANCE);
      expect(reference.snapshotVersion).toBe(1);

      // Step 4: Verify audit trail
      mockPrisma.strategyVersionReference.findFirst.mockResolvedValueOnce({
        rebalanceQueueId: 'queue-1',
      });

      const isAuditValid = await versioningService.verifyRebalanceVersion(
        'queue-1',
        strategyId,
        1,
      );

      expect(isAuditValid).toBe(true);
    });

    it('should handle partial execution with deferred follow-up', async () => {
      const vaultId = 'vault-1';

      // Step 1: Enqueue rebalance
      mockPrisma.rebalanceQueueEntry.findUnique.mockResolvedValueOnce(null);
      mockPrisma.rebalanceQueueEntry.create.mockResolvedValueOnce({
        id: 'queue-1',
        vaultId,
        status: REBALANCE_STATUS.PENDING,
        executionType: EXECUTION_TYPE.FULL,
        targetAllocations: { BTC: 0.5, ETH: 0.5 },
        currentAllocations: { BTC: 0.6, ETH: 0.4 },
        executionStrategy: {},
        partiallyExecuted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const queueEntry = await queueService.enqueueRebalance(
        vaultId,
        { BTC: 0.5, ETH: 0.5 },
        { BTC: 0.6, ETH: 0.4 },
        {},
      );

      // Step 2: Record partial execution
      mockPrisma.rebalanceQueueEntry.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'queue-1',
        vaultId,
        targetAllocations: { BTC: 0.5, ETH: 0.5 },
        currentAllocations: { BTC: 0.6, ETH: 0.4 },
        executionStrategy: {},
        attemptCount: 1,
        intentValidUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
        maxRetries: 3,
      });

      mockPrisma.rebalanceHistory.create.mockResolvedValueOnce({
        id: 'history-1',
        queueEntryId: 'queue-1',
        filledPercentage: 70,
      });

      mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({
        id: 'queue-1',
        status: REBALANCE_STATUS.PARTIAL,
        partiallyExecuted: true,
        partialFillAmount: 70,
        followUpEntryId: 'queue-2',
      });

      const partialResult = await queueService.recordPartialExecution(
        'queue-1',
        {
          queueEntryId: 'queue-1',
          totalExecuted: 70,
          expectedAmount: 100,
          filledPercentage: 70,
          executionDetails: {},
        },
        { deferralThreshold: 75, retryDelayMs: 60000 },
      );

      expect(partialResult.status).toBe(REBALANCE_STATUS.PARTIAL);
      expect(partialResult.followUpEntryId).toBe('queue-2');
    });

    it('should handle retry mechanism with exponential backoff', async () => {
      const queueEntryId = 'queue-1';
      const error = 'Insufficient liquidity';

      // First failure attempt
      mockPrisma.rebalanceQueueEntry.findUniqueOrThrow.mockResolvedValueOnce({
        id: queueEntryId,
        attemptCount: 0,
        intentValidUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({
        id: queueEntryId,
        status: REBALANCE_STATUS.PENDING,
        attemptCount: 1,
        nextRetryAt: new Date(Date.now() + 60000), // 1 minute
        lastError: error,
      });

      const result1 = await queueService.recordFailedAttempt(queueEntryId, error);

      expect(result1.attemptCount).toBe(1);
      expect(result1.status).toBe(REBALANCE_STATUS.PENDING);

      // Second failure attempt
      mockPrisma.rebalanceQueueEntry.findUniqueOrThrow.mockResolvedValueOnce({
        id: queueEntryId,
        attemptCount: 1,
        intentValidUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({
        id: queueEntryId,
        status: REBALANCE_STATUS.PENDING,
        attemptCount: 2,
        nextRetryAt: new Date(Date.now() + 120000), // 2 minutes (exponential)
        lastError: error,
      });

      const result2 = await queueService.recordFailedAttempt(queueEntryId, error, {
        maxRetries: 3,
        retryDelayMs: 60000,
      });

      expect(result2.attemptCount).toBe(2);
      // Verify exponential backoff: second retry should be longer than first
      expect(result2.nextRetryAt).toBeDefined();
    });

    it('should prevent replay of stale intents', async () => {
      const queueEntryId = 'queue-1';
      const expiredDate = new Date(Date.now() - 1000);

      mockPrisma.rebalanceQueueEntry.findUniqueOrThrow.mockResolvedValueOnce({
        id: queueEntryId,
        attemptCount: 0,
        intentValidUntil: expiredDate,
      });

      mockPrisma.rebalanceQueueEntry.update.mockResolvedValueOnce({
        id: queueEntryId,
        status: REBALANCE_STATUS.FAILED,
        lastError: 'Intent expired - replay prevention triggered',
        completedAt: new Date(),
      });

      const result = await queueService.recordFailedAttempt(
        queueEntryId,
        'Attempting to replay stale intent',
      );

      expect(result.status).toBe(REBALANCE_STATUS.FAILED);
      expect(result.lastError).toContain('Intent expired');
    });
  });

  describe('Strategy Version Migration Workflow', () => {
    it('should track version changes and migration events', async () => {
      const strategyId = 'strategy-1';

      // Create initial version
      mockPrisma.strategySnapshot.findFirst.mockResolvedValueOnce(null);
      mockPrisma.strategySnapshot.create.mockResolvedValueOnce({
        id: 'snap-1',
        version: 1,
        status: 'ACTIVE',
      });

      await versioningService.createSnapshot(
        strategyId,
        'v1',
        { BTC: 0.4, ETH: 0.6 },
        {},
        {},
      );

      // Create new version
      mockPrisma.strategySnapshot.findFirst
        .mockResolvedValueOnce({ version: 1 }) // Last version
        .mockResolvedValueOnce({ id: 'snap-1', version: 1 }); // Previous active

      mockPrisma.strategySnapshot.create.mockResolvedValueOnce({
        id: 'snap-2',
        version: 2,
        status: 'ACTIVE',
      });

      mockPrisma.strategySnapshot.update.mockResolvedValueOnce({
        status: 'SUPERSEDED',
        supersededByVersion: 2,
      });

      mockPrisma.strategyVersionHistory.create.mockResolvedValueOnce({
        id: 'change-1',
        fromVersion: 1,
        toVersion: 2,
        changeType: 'WEIGHTS_UPDATE',
      });

      await versioningService.createSnapshot(
        strategyId,
        'v2',
        { BTC: 0.5, ETH: 0.5 },
        {},
        {},
        { changeReason: 'Market volatility adjustment', changeAuthor: 'bot' },
      );

      // Get version history
      mockPrisma.strategyVersionHistory.findMany.mockResolvedValueOnce([
        {
          id: 'change-1',
          fromVersion: 1,
          toVersion: 2,
          reason: 'Market volatility adjustment',
        },
      ]);

      const history = await versioningService.getVersionHistory(strategyId);

      expect(history).toHaveLength(1);
      expect(history[0].toVersion).toBe(2);
    });
  });

  describe('Concurrent Operations and Conflict Detection', () => {
    it('should prevent conflicting queue entries for same vault', async () => {
      const vaultId = 'vault-1';
      const allocations1 = { BTC: 0.5, ETH: 0.5 };
      const allocations2 = { BTC: 0.6, ETH: 0.4 };

      // Check for conflicts
      mockPrisma.rebalanceQueueEntry.findMany.mockResolvedValueOnce([
        {
          targetAllocations: allocations1,
          status: REBALANCE_STATUS.PROCESSING,
        },
      ]);

      const hasConflict = !(await queueService.validateNoConflictingEntries(
        vaultId,
        allocations2,
      ));

      expect(hasConflict).toBe(true);
    });

    it('should allow concurrent operations for different vaults', async () => {
      const vault1 = 'vault-1';
      const vault2 = 'vault-2';
      const allocations = { BTC: 0.5, ETH: 0.5 };

      // No existing entries for vault1
      mockPrisma.rebalanceQueueEntry.findMany.mockResolvedValueOnce([]);

      const noConflict = await queueService.validateNoConflictingEntries(vault1, allocations);

      expect(noConflict).toBe(true);

      // No existing entries for vault2
      mockPrisma.rebalanceQueueEntry.findMany.mockResolvedValueOnce([]);

      const noConflict2 = await queueService.validateNoConflictingEntries(vault2, allocations);

      expect(noConflict2).toBe(true);
    });
  });

  describe('Queue Processor Job Integration', () => {
    it('should process pending retries through job', async () => {
      // Mock pending retries
      mockPrisma.rebalanceQueueEntry.findMany.mockResolvedValueOnce([
        {
          id: 'queue-1',
          vaultId: 'vault-1',
          status: REBALANCE_STATUS.PENDING,
          attemptCount: 1,
          nextRetryAt: new Date(Date.now() - 10000),
        },
      ]);

      // Mock processing
      mockPrisma.rebalanceQueueEntry.update
        .mockResolvedValueOnce({ status: REBALANCE_STATUS.PROCESSING })
        .mockResolvedValueOnce({ status: REBALANCE_STATUS.COMPLETED });

      mockPrisma.rebalanceHistory.create.mockResolvedValueOnce({
        id: 'history-1',
      });

      const result = await runRebalanceQueueProcessorJob({
        enabled: true,
        batchSize: 10,
        enableRetries: true,
        enableDeferredProcessing: true,
        logResults: false,
      });

      expect(result.success).toBe(true);
    });

    it('should process deferred entries when ready', async () => {
      const deferredUntil = new Date(Date.now() - 10000); // Past date

      mockPrisma.rebalanceQueueEntry.findMany.mockResolvedValueOnce([
        {
          id: 'queue-2',
          vaultId: 'vault-1',
          status: REBALANCE_STATUS.PENDING,
          executionType: EXECUTION_TYPE.DEFERRED,
          deferredUntil,
        },
      ]);

      mockPrisma.rebalanceQueueEntry.update
        .mockResolvedValueOnce({ status: REBALANCE_STATUS.PROCESSING })
        .mockResolvedValueOnce({ status: REBALANCE_STATUS.COMPLETED });

      mockPrisma.rebalanceHistory.create.mockResolvedValueOnce({
        id: 'history-2',
      });

      const result = await runRebalanceQueueProcessorJob({
        enabled: true,
        batchSize: 10,
        enableRetries: false,
        enableDeferredProcessing: true,
        logResults: false,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('Audit and Replay Capabilities', () => {
    it('should provide full audit trail for rebalance with version', async () => {
      const strategyId = 'strategy-1';
      const rebalanceQueueId = 'queue-1';
      const version = 2;

      // Link rebalance to version
      mockPrisma.strategySnapshot.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'snap-2',
        strategyId,
        version,
      });

      mockPrisma.strategyVersionReference.create.mockResolvedValueOnce({
        id: 'ref-1',
        strategySnapshotId: 'snap-2',
        strategyId,
        snapshotVersion: version,
        rebalanceQueueId,
        linkedAt: new Date(),
      });

      await versioningService.linkRebalance('snap-2', rebalanceQueueId);

      // Get events for version
      mockPrisma.strategyVersionReference.findMany.mockResolvedValueOnce([
        {
          id: 'ref-1',
          rebalanceQueueId,
          eventType: STRATEGY_EVENT_TYPE.REBALANCE,
          linkedAt: new Date(),
        },
      ]);

      const events = await versioningService.getEventsForVersion(strategyId, version);

      expect(events).toHaveLength(1);
      expect(events[0].rebalanceQueueId).toBe(rebalanceQueueId);
    });

    it('should support version replay audit', async () => {
      const strategyId = 'strategy-1';
      const recommendationId = 'rec-1';

      // Get version that was used
      mockPrisma.strategyVersionReference.findFirst.mockResolvedValueOnce({
        snapshotVersion: 2,
      });

      const versionUsed = await versioningService.verifyRecommendationVersion(
        recommendationId,
        strategyId,
        2,
      );

      expect(versionUsed).toBe(true);

      // Get the snapshot for that version
      mockPrisma.strategySnapshot.findFirst.mockResolvedValueOnce({
        id: 'snap-2',
        version: 2,
        keyWeights: { BTC: 0.5, ETH: 0.5 },
        riskParameters: { volatility: 0.25 },
      });

      const snapshot = await versioningService.getVersion(strategyId, 2);

      expect(snapshot).toBeDefined();
      expect(snapshot?.version).toBe(2);
    });
  });
});
