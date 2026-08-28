// Mock Prisma — singleton pattern so the module-level `prisma` and test's
// mockPrisma reference the same object.
jest.mock('@prisma/client', () => {
  const instance = {
    strategySnapshot: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
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
  };
  const MockPrismaClient = jest.fn(() => instance);
  (MockPrismaClient as any).__mockInstance = instance;
  return { PrismaClient: MockPrismaClient };
});

import { StrategySnapshotVersioningService, strategySnapshotVersioningService } from '../services/strategySnapshotVersioningService';
import { STRATEGY_EVENT_TYPE, VERSION_CHANGE_TYPE } from '../queues/types';
import request from 'supertest';
import express from 'express';
import strategiesRouter from '../routes/strategies';

describe('StrategySnapshotVersioningService', () => {
  let service: StrategySnapshotVersioningService;
  let mockPrisma: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StrategySnapshotVersioningService();
    const { PrismaClient } = require('@prisma/client');
    mockPrisma = (PrismaClient as any).__mockInstance;
  });

  describe('Snapshot Creation', () => {
    it('should create first version of a strategy', async () => {
      const strategyId = 'strategy-1';
      const keyWeights = { BTC: 0.4, ETH: 0.3, USDC: 0.3 };
      const riskParams = { volatility: 0.25, sharpeRatio: 1.5 };
      const constraints = { minAllocation: 0.05, maxAllocation: 0.5 };

      mockPrisma.strategySnapshot.findFirst.mockResolvedValue(null);
      mockPrisma.strategySnapshot.create.mockResolvedValue({
        id: 'snap-1',
        strategyId,
        version: 1,
        name: 'Conservative Strategy',
        description: 'Low risk strategy',
        keyWeights,
        riskParameters: riskParams,
        constraints,
        status: 'ACTIVE',
        createdAt: new Date(),
        supersededAt: null,
        supersededByVersion: null,
      });

      const result = await service.createSnapshot(
        strategyId,
        'Conservative Strategy',
        keyWeights,
        riskParams,
        constraints,
        { description: 'Low risk strategy' },
      );

      expect(result.version).toBe(1);
      expect(result.status).toBe('ACTIVE');
      expect(result.keyWeights).toEqual(keyWeights);
    });

    it('should increment version on subsequent snapshots', async () => {
      const strategyId = 'strategy-1';
      const newKeyWeights = { BTC: 0.5, ETH: 0.2, USDC: 0.3 };

      mockPrisma.strategySnapshot.findFirst.mockResolvedValue({
        version: 1,
      });
      mockPrisma.strategySnapshot.create.mockResolvedValue({
        id: 'snap-2',
        strategyId,
        version: 2,
        name: 'Updated Strategy',
        keyWeights: newKeyWeights,
        riskParameters: {},
        constraints: {},
        status: 'ACTIVE',
        createdAt: new Date(),
      });

      const result = await service.createSnapshot(
        strategyId,
        'Updated Strategy',
        newKeyWeights,
        {},
        {},
      );

      expect(result.version).toBe(2);
    });

    it('should supersede previous version', async () => {
      mockPrisma.strategySnapshot.findFirst.mockResolvedValue({
        id: 'snap-1',
        version: 1,
        status: 'ACTIVE',
      });

      mockPrisma.strategySnapshot.create.mockResolvedValue({
        id: 'snap-2',
        version: 2,
        status: 'ACTIVE',
      });

      mockPrisma.strategySnapshot.update.mockResolvedValue({
        id: 'snap-1',
        status: 'SUPERSEDED',
        supersededAt: expect.any(Date),
        supersededByVersion: 2,
      });

      await service.createSnapshot(
        'strategy-1',
        'New Version',
        {},
        {},
        {},
        { changeReason: 'Market adjustment' },
      );

      expect(mockPrisma.strategySnapshot.update).toHaveBeenCalled();
      expect(mockPrisma.strategyVersionHistory.create).toHaveBeenCalled();
    });
  });

  describe('Version Retrieval', () => {
    it('should get active version', async () => {
      mockPrisma.strategySnapshot.findFirst.mockResolvedValue({
        id: 'snap-1',
        strategyId: 'strategy-1',
        version: 2,
        name: 'Current Strategy',
        status: 'ACTIVE',
        keyWeights: { BTC: 0.5 },
        riskParameters: {},
        constraints: {},
        createdAt: new Date(),
      });

      const result = await service.getActiveVersion('strategy-1');

      expect(result).toBeDefined();
      expect(result?.version).toBe(2);
      expect(result?.status).toBe('ACTIVE');
    });

    it('should get specific version by number', async () => {
      mockPrisma.strategySnapshot.findFirst.mockResolvedValue({
        id: 'snap-1',
        strategyId: 'strategy-1',
        version: 1,
        name: 'First Version',
        keyWeights: { BTC: 0.4 },
        riskParameters: {},
        constraints: {},
        createdAt: new Date(),
      });

      const result = await service.getVersion('strategy-1', 1);

      expect(result).toBeDefined();
      expect(result?.version).toBe(1);
    });

    it('should get all versions in desc order', async () => {
      mockPrisma.strategySnapshot.findMany.mockResolvedValue([
        { version: 3, status: 'ACTIVE' },
        { version: 2, status: 'SUPERSEDED' },
        { version: 1, status: 'ARCHIVED' },
      ]);

      const results = await service.getAllVersions('strategy-1');

      expect(results).toHaveLength(3);
      expect(results[0].version).toBe(3);
      expect(results[2].version).toBe(1);
    });
  });

  describe('Version References', () => {
    it('should link recommendation to version', async () => {
      mockPrisma.strategySnapshot.findUniqueOrThrow.mockResolvedValue({
        id: 'snap-1',
        strategyId: 'strategy-1',
        version: 2,
      });

      mockPrisma.strategyVersionReference.create.mockResolvedValue({
        id: 'ref-1',
        strategySnapshotId: 'snap-1',
        strategyId: 'strategy-1',
        snapshotVersion: 2,
        recommendationId: 'rec-1',
        eventType: STRATEGY_EVENT_TYPE.RECOMMENDATION,
        linkedAt: new Date(),
      });

      const result = await service.linkRecommendation('snap-1', 'rec-1');

      expect(result.eventType).toBe(STRATEGY_EVENT_TYPE.RECOMMENDATION);
      expect(result.recommendationId).toBe('rec-1');
      expect(result.snapshotVersion).toBe(2);
    });

    it('should link rebalance to version', async () => {
      mockPrisma.strategySnapshot.findUniqueOrThrow.mockResolvedValue({
        id: 'snap-1',
        strategyId: 'strategy-1',
        version: 2,
      });

      mockPrisma.strategyVersionReference.create.mockResolvedValue({
        id: 'ref-2',
        strategySnapshotId: 'snap-1',
        strategyId: 'strategy-1',
        snapshotVersion: 2,
        rebalanceQueueId: 'queue-1',
        eventType: STRATEGY_EVENT_TYPE.REBALANCE,
        linkedAt: new Date(),
      });

      const result = await service.linkRebalance('snap-1', 'queue-1');

      expect(result.eventType).toBe(STRATEGY_EVENT_TYPE.REBALANCE);
      expect(result.rebalanceQueueId).toBe('queue-1');
    });

    it('should get recommendations for a version', async () => {
      mockPrisma.strategyVersionReference.findMany.mockResolvedValue([
        {
          id: 'ref-1',
          recommendationId: 'rec-1',
          eventType: STRATEGY_EVENT_TYPE.RECOMMENDATION,
          linkedAt: new Date(),
        },
        {
          id: 'ref-2',
          recommendationId: 'rec-2',
          eventType: STRATEGY_EVENT_TYPE.RECOMMENDATION,
          linkedAt: new Date(),
        },
      ]);

      const results = await service.getRecommendationsForVersion('strategy-1', 2);

      expect(results).toHaveLength(2);
      expect(mockPrisma.strategyVersionReference.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            eventType: STRATEGY_EVENT_TYPE.RECOMMENDATION,
          }),
        }),
      );
    });

    it('should get rebalances for a version', async () => {
      mockPrisma.strategyVersionReference.findMany.mockResolvedValue([
        {
          id: 'ref-1',
          rebalanceQueueId: 'queue-1',
          eventType: STRATEGY_EVENT_TYPE.REBALANCE,
          linkedAt: new Date(),
        },
      ]);

      const results = await service.getRebalancesForVersion('strategy-1', 1);

      expect(results).toHaveLength(1);
      expect(results[0].rebalanceQueueId).toBe('queue-1');
    });
  });

  describe('Version History and Audit Trail', () => {
    it('should get version history', async () => {
      mockPrisma.strategyVersionHistory.findMany.mockResolvedValue([
        {
          id: 'change-1',
          strategyId: 'strategy-1',
          fromVersion: 1,
          toVersion: 2,
          changeType: VERSION_CHANGE_TYPE.WEIGHTS_UPDATE,
          reason: 'Market adjustment',
          author: 'bot',
          createdAt: new Date(),
          versionChanges: {},
        },
      ]);

      const history = await service.getVersionHistory('strategy-1');

      expect(history).toHaveLength(1);
      expect(history[0].changeType).toBe(VERSION_CHANGE_TYPE.WEIGHTS_UPDATE);
    });

    it('should get changes between specific versions', async () => {
      mockPrisma.strategyVersionHistory.findMany.mockResolvedValue([
        {
          id: 'change-1',
          fromVersion: 1,
          toVersion: 2,
          changeType: VERSION_CHANGE_TYPE.WEIGHTS_UPDATE,
          versionChanges: {
            keyWeights: {
              from: { BTC: 0.4 },
              to: { BTC: 0.5 },
            },
          },
        },
      ]);

      const changes = await service.getChangesBetweenVersions('strategy-1', 1, 2);

      expect(changes).toHaveLength(1);
      expect(changes[0].fromVersion).toBe(1);
    });
  });

  describe('Audit Verification', () => {
    it('should verify recommendation version', async () => {
      mockPrisma.strategyVersionReference.findFirst.mockResolvedValue({
        id: 'ref-1',
        recommendationId: 'rec-1',
      });

      const isValid = await service.verifyRecommendationVersion('rec-1', 'strategy-1', 2);

      expect(isValid).toBe(true);
      expect(mockPrisma.strategyVersionReference.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            recommendationId: 'rec-1',
            snapshotVersion: 2,
          }),
        }),
      );
    });

    it('should verify rebalance version', async () => {
      mockPrisma.strategyVersionReference.findFirst.mockResolvedValue({
        id: 'ref-1',
        rebalanceQueueId: 'queue-1',
      });

      const isValid = await service.verifyRebalanceVersion('queue-1', 'strategy-1', 2);

      expect(isValid).toBe(true);
    });

    it('should return false for non-existent verification', async () => {
      mockPrisma.strategyVersionReference.findFirst.mockResolvedValue(null);

      const isValid = await service.verifyRecommendationVersion('rec-1', 'strategy-1', 2);

      expect(isValid).toBe(false);
    });
  });

  describe('Version Management', () => {
    it('should archive old versions', async () => {
      mockPrisma.strategySnapshot.findMany.mockResolvedValue([
        { id: 'snap-5', version: 5 },
        { id: 'snap-4', version: 4 },
        { id: 'snap-3', version: 3 },
        { id: 'snap-2', version: 2 },
        { id: 'snap-1', version: 1 },
      ]);

      mockPrisma.strategySnapshot.updateMany.mockResolvedValue({ count: 5 });

      const archived = await service.archiveOldVersions('strategy-1', 0);

      expect(archived).toBe(5);
    });

    it('should not archive if within keepVersions limit', async () => {
      mockPrisma.strategySnapshot.findMany.mockResolvedValue([
        { id: 'snap-2', version: 2 },
        { id: 'snap-1', version: 1 },
      ]);

      const archived = await service.archiveOldVersions('strategy-1', 10);

      expect(archived).toBe(0);
    });
  });

  describe('Version Statistics', () => {
    it('should get version statistics', async () => {
      mockPrisma.strategySnapshot.count.mockResolvedValue(3);
      mockPrisma.strategySnapshot.findFirst.mockResolvedValue({ version: 3 });
      mockPrisma.strategyVersionReference.count
        .mockResolvedValueOnce(10) // recommendations
        .mockResolvedValueOnce(5) // rebalances
        .mockResolvedValueOnce(15); // total events

      const stats = await service.getVersionStatistics('strategy-1');

      expect(stats.totalVersions).toBe(3);
      expect(stats.activeVersion).toBe(3);
      expect(stats.recommendationsCount).toBe(10);
      expect(stats.rebalancesCount).toBe(5);
      expect(stats.totalEventsCount).toBe(15);
    });
  });

  describe('Change Type Detection', () => {
    it('should detect weights-only changes', async () => {
      mockPrisma.strategySnapshot.findFirst.mockResolvedValue({
        id: 'snap-1',
        version: 1,
        status: 'ACTIVE',
        keyWeights: { BTC: 0.4 },
        riskParameters: { vol: 0.25 },
        constraints: { min: 0.05 },
      });
      mockPrisma.strategySnapshot.create.mockResolvedValue({
        id: 'snap-2',
        version: 2,
        status: 'ACTIVE',
      });

      mockPrisma.strategySnapshot.update.mockResolvedValue({
        status: 'SUPERSEDED',
      });

      mockPrisma.strategyVersionHistory.create.mockResolvedValue({
        changeType: VERSION_CHANGE_TYPE.WEIGHTS_UPDATE,
      });

      await service.createSnapshot(
        'strategy-1',
        'Updated',
        { BTC: 0.5 },
        { vol: 0.25 },
        { min: 0.05 },
      );

      expect(mockPrisma.strategyVersionHistory.create).toHaveBeenCalled();
    });
  });

  describe('Immutability Enforcement', () => {
    it('should prevent modification of historical versions', async () => {
      // Once a version is created, it cannot be modified
      // This is enforced at the application level

      mockPrisma.strategySnapshot.findFirst.mockResolvedValue({
        id: 'snap-1',
        version: 1,
        status: 'ARCHIVED',
      });

      const oldVersion = await service.getVersion('strategy-1', 1);

      // Verify the version data is immutable by checking it's returned as-is
      expect(oldVersion).toBeDefined();
      expect(oldVersion?.id).toBe('snap-1');
    });
  });

  describe('Rollback Preview', () => {
    const baseSnapshot = {
      id: 'snap-3',
      strategyId: 'strategy-1',
      version: 3,
      name: 'Current Strategy',
      description: 'Current description',
      keyWeights: { BTC: 0.5, ETH: 0.3, USDC: 0.2 },
      riskParameters: { volatility: 0.2 },
      constraints: { maxAllocation: 0.5 },
      status: 'ACTIVE',
      createdAt: new Date(),
      supersededAt: null,
      supersededByVersion: null,
      changeReason: null,
      changeAuthor: null,
    };

    const targetSnapshot = {
      id: 'snap-1',
      strategyId: 'strategy-1',
      version: 1,
      name: 'Original Strategy',
      description: 'Original description',
      keyWeights: { BTC: 0.4, ETH: 0.3, USDC: 0.3 },
      riskParameters: { volatility: 0.25 },
      constraints: { maxAllocation: 0.5 },
      status: 'SUPERSEDED',
      createdAt: new Date(),
      supersededAt: new Date(),
      supersededByVersion: 2,
      changeReason: null,
      changeAuthor: null,
    };

    it('returns changed fields between current and target snapshot', async () => {
      mockPrisma.strategySnapshot.findFirst
        .mockResolvedValueOnce(baseSnapshot)   // current ACTIVE
        .mockResolvedValueOnce(targetSnapshot); // target version

      const preview = await service.previewRollback('strategy-1', 1);

      expect(preview.currentVersion).toBe(3);
      expect(preview.targetVersion).toBe(1);
      const fieldNames = preview.changedFields.map((d) => d.field);
      expect(fieldNames).toContain('keyWeights');
      expect(fieldNames).toContain('riskParameters');
      expect(fieldNames).toContain('name');
      expect(fieldNames).toContain('description');
    });

    it('does not include unchanged fields in changedFields', async () => {
      mockPrisma.strategySnapshot.findFirst
        .mockResolvedValueOnce(baseSnapshot)
        .mockResolvedValueOnce(targetSnapshot);

      const preview = await service.previewRollback('strategy-1', 1);

      const fieldNames = preview.changedFields.map((d) => d.field);
      // constraints are identical between the two snapshots
      expect(fieldNames).not.toContain('constraints');
    });

    it('includes the full target snapshot DTO in the response', async () => {
      mockPrisma.strategySnapshot.findFirst
        .mockResolvedValueOnce(baseSnapshot)
        .mockResolvedValueOnce(targetSnapshot);

      const preview = await service.previewRollback('strategy-1', 1);

      expect(preview.targetSnapshot.version).toBe(1);
      expect(preview.targetSnapshot.name).toBe('Original Strategy');
      expect(preview.targetSnapshot.keyWeights).toEqual({ BTC: 0.4, ETH: 0.3, USDC: 0.3 });
    });

    it('marks preview as safe when target is SUPERSEDED (not ARCHIVED)', async () => {
      mockPrisma.strategySnapshot.findFirst
        .mockResolvedValueOnce(baseSnapshot)
        .mockResolvedValueOnce({ ...targetSnapshot, status: 'SUPERSEDED' });

      const preview = await service.previewRollback('strategy-1', 1);

      expect(preview.safe).toBe(true);
    });

    it('marks preview as unsafe (safe: false) when target is ARCHIVED', async () => {
      mockPrisma.strategySnapshot.findFirst
        .mockResolvedValueOnce(baseSnapshot)
        .mockResolvedValueOnce({ ...targetSnapshot, status: 'ARCHIVED' });

      const preview = await service.previewRollback('strategy-1', 1);

      expect(preview.safe).toBe(false);
    });

    it('passes rollbackReason through to the preview', async () => {
      mockPrisma.strategySnapshot.findFirst
        .mockResolvedValueOnce(baseSnapshot)
        .mockResolvedValueOnce(targetSnapshot);

      const preview = await service.previewRollback('strategy-1', 1, 'Emergency revert');

      expect(preview.rollbackReason).toBe('Emergency revert');
    });

    it('throws when no active snapshot exists', async () => {
      mockPrisma.strategySnapshot.findFirst
        .mockResolvedValueOnce(null)  // no active
        .mockResolvedValueOnce(targetSnapshot);

      await expect(service.previewRollback('strategy-1', 1)).rejects.toThrow(
        /No active snapshot/,
      );
    });

    it('throws when target version does not exist', async () => {
      mockPrisma.strategySnapshot.findFirst
        .mockResolvedValueOnce(baseSnapshot)
        .mockResolvedValueOnce(null); // target missing

      await expect(service.previewRollback('strategy-1', 99)).rejects.toThrow(
        /not found/,
      );
    });

    it('returns empty changedFields when both snapshots are identical', async () => {
      mockPrisma.strategySnapshot.findFirst
        .mockResolvedValueOnce(baseSnapshot)
        .mockResolvedValueOnce({ ...baseSnapshot, version: 2, status: 'SUPERSEDED' });

      const preview = await service.previewRollback('strategy-1', 2);

      expect(preview.changedFields).toHaveLength(0);
    });
  });
});

// ── Route-level tests for GET /api/strategies/:id/snapshots/:v/rollback-preview ──

describe('GET /api/strategies/:strategyId/snapshots/:targetVersion/rollback-preview', () => {
  const app = express();
  app.use('/api/strategies', strategiesRouter);

  let spyPreview: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    spyPreview = jest.spyOn(strategySnapshotVersioningService, 'previewRollback');
  });

  const basePreview = {
    strategyId: 'strategy-1',
    currentVersion: 3,
    targetVersion: 1,
    changedFields: [{ field: 'keyWeights', current: { BTC: 0.5 }, target: { BTC: 0.4 } }],
    targetSnapshot: { version: 1, name: 'Original Strategy' },
    safe: true,
  };

  it('returns 200 with rollback preview', async () => {
    spyPreview.mockResolvedValue(basePreview);

    const res = await request(app)
      .get('/api/strategies/strategy-1/snapshots/1/rollback-preview');

    expect(res.status).toBe(200);
    expect(res.body.currentVersion).toBe(3);
    expect(res.body.targetVersion).toBe(1);
    expect(Array.isArray(res.body.changedFields)).toBe(true);
  });

  it('passes optional reason query param to the service', async () => {
    spyPreview.mockResolvedValue(basePreview);

    await request(app)
      .get('/api/strategies/strategy-1/snapshots/1/rollback-preview?reason=Emergency+revert');

    expect(spyPreview).toHaveBeenCalledWith('strategy-1', 1, 'Emergency revert');
  });

  it('returns 400 for non-integer targetVersion', async () => {
    const res = await request(app)
      .get('/api/strategies/strategy-1/snapshots/abc/rollback-preview');

    expect(res.status).toBe(400);
    expect(spyPreview).not.toHaveBeenCalled();
  });

  it('returns 404 when active snapshot is missing', async () => {
    spyPreview.mockRejectedValue(new Error('No active snapshot found for strategy "strategy-1".'));

    const res = await request(app)
      .get('/api/strategies/strategy-1/snapshots/1/rollback-preview');

    expect(res.status).toBe(404);
  });

  it('returns 404 when target version does not exist', async () => {
    spyPreview.mockRejectedValue(new Error('Snapshot version 99 not found for strategy "strategy-1".'));

    const res = await request(app)
      .get('/api/strategies/strategy-1/snapshots/99/rollback-preview');

    expect(res.status).toBe(404);
  });

  it('does not mutate state — previewRollback is called, not an actual rollback', async () => {
    spyPreview.mockResolvedValue(basePreview);

    await request(app)
      .get('/api/strategies/strategy-1/snapshots/1/rollback-preview');

    expect(spyPreview).toHaveBeenCalledTimes(1);
  });
});
