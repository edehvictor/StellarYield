import { PrismaClient } from '@prisma/client';
import { STRATEGY_EVENT_TYPE, StrategyEventType, VERSION_CHANGE_TYPE, VersionChangeType } from '../queues/types';

const prisma = new PrismaClient();

/**
 * Strategy snapshot DTO for versioning system.
 */
export interface StrategySnapshotDTO {
  id: string;
  strategyId: string;
  version: number;
  name: string;
  description?: string;
  keyWeights: Record<string, number>;
  riskParameters: Record<string, unknown>;
  constraints: Record<string, unknown>;
  status: string;
  createdAt: Date;
  supersededAt?: Date;
  supersededByVersion?: number;
  changeReason?: string;
  changeAuthor?: string;
}

/**
 * Version reference for tracking what version was used in recommendations/rebalances.
 */
export interface VersionReferenceDTO {
  id: string;
  strategySnapshotId: string;
  strategyId: string;
  snapshotVersion: number;
  recommendationId?: string;
  rebalanceQueueId?: string;
  eventType: StrategyEventType;
  linkedAt: Date;
  linkedBy?: string;
}

/**
 * Strategy version change record for audit trail.
 */
export interface VersionChangeRecordDTO {
  id: string;
  strategyId: string;
  versionChanges: Record<string, unknown>;
  fromVersion: number;
  toVersion: number;
  changeType: VersionChangeType;
  reason: string;
  author?: string;
  createdAt: Date;
}

/**
 * StrategySnapshotVersioningService
 *
 * Manages versioned snapshots of strategy configuration with:
 * - Immutable historical versions
 * - Reference tracking for recommendations and rebalances
 * - Audit trail of all version changes
 * - Support for reading historical versions
 *
 * Security: Historical versions are immutable once active.
 * All version references are tracked for audit purposes.
 */
export class StrategySnapshotVersioningService {
  /**
   * Create a new snapshot version for a strategy.
   * Automatically supersedes the previous active version.
   */
  async createSnapshot(
    strategyId: string,
    name: string,
    keyWeights: Record<string, number>,
    riskParameters: Record<string, unknown>,
    constraints: Record<string, unknown>,
    options?: {
      description?: string;
      changeReason?: string;
      changeAuthor?: string;
    },
  ): Promise<StrategySnapshotDTO> {
    // Get the next version number
    const lastVersion = await prisma.strategySnapshot.findFirst({
      where: { strategyId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const nextVersion = (lastVersion?.version ?? 0) + 1;

    // Get the previously active version
    const previousActive = await prisma.strategySnapshot.findFirst({
      where: {
        strategyId,
        status: 'ACTIVE',
      },
    });

    // Create new version
    const snapshot = await prisma.strategySnapshot.create({
      data: {
        strategyId,
        version: nextVersion,
        name,
        description: options?.description,
        keyWeights,
        riskParameters,
        constraints,
        status: 'ACTIVE',
        changeReason: options?.changeReason,
        changeAuthor: options?.changeAuthor,
      },
    });

    // Supersede previous version
    if (previousActive) {
      await prisma.strategySnapshot.update({
        where: { id: previousActive.id },
        data: {
          status: 'SUPERSEDED',
          supersededAt: new Date(),
          supersededByVersion: nextVersion,
        },
      });

      // Record version change
      await this.recordVersionChange(
        strategyId,
        previousActive.version,
        nextVersion,
        this.detectChangeType(previousActive, snapshot),
        options?.changeReason || 'Version update',
        options?.changeAuthor,
        previousActive,
        snapshot,
      );
    }

    return this.mapToDTO(snapshot);
  }

  /**
   * Get the current active version of a strategy.
   */
  async getActiveVersion(strategyId: string): Promise<StrategySnapshotDTO | null> {
    const snapshot = await prisma.strategySnapshot.findFirst({
      where: {
        strategyId,
        status: 'ACTIVE',
      },
    });

    return snapshot ? this.mapToDTO(snapshot) : null;
  }

  /**
   * Get a specific version of a strategy.
   */
  async getVersion(strategyId: string, version: number): Promise<StrategySnapshotDTO | null> {
    const snapshot = await prisma.strategySnapshot.findFirst({
      where: {
        strategyId,
        version,
      },
    });

    return snapshot ? this.mapToDTO(snapshot) : null;
  }

  /**
   * Get all versions of a strategy (historical lookup).
   */
  async getAllVersions(strategyId: string): Promise<StrategySnapshotDTO[]> {
    const snapshots = await prisma.strategySnapshot.findMany({
      where: { strategyId },
      orderBy: { version: 'desc' },
    });

    return snapshots.map((s) => this.mapToDTO(s));
  }

  /**
   * Link a recommendation to a specific strategy version.
   * Used to track which version rules were active when recommendation was made.
   */
  async linkRecommendation(
    strategySnapshotId: string,
    recommendationId: string,
    linkedBy?: string,
  ): Promise<VersionReferenceDTO> {
    const snapshot = await prisma.strategySnapshot.findUniqueOrThrow({
      where: { id: strategySnapshotId },
    });

    const reference = await prisma.strategyVersionReference.create({
      data: {
        strategySnapshotId,
        strategyId: snapshot.strategyId,
        snapshotVersion: snapshot.version,
        recommendationId,
        eventType: STRATEGY_EVENT_TYPE.RECOMMENDATION,
        linkedBy,
      },
    });

    return this.mapReferenceToDTO(reference);
  }

  /**
   * Link a rebalance execution to a specific strategy version.
   * Used to track which version rules were active when rebalance occurred.
   */
  async linkRebalance(
    strategySnapshotId: string,
    rebalanceQueueId: string,
    linkedBy?: string,
  ): Promise<VersionReferenceDTO> {
    const snapshot = await prisma.strategySnapshot.findUniqueOrThrow({
      where: { id: strategySnapshotId },
    });

    const reference = await prisma.strategyVersionReference.create({
      data: {
        strategySnapshotId,
        strategyId: snapshot.strategyId,
        snapshotVersion: snapshot.version,
        rebalanceQueueId,
        eventType: STRATEGY_EVENT_TYPE.REBALANCE,
        linkedBy,
      },
    });

    return this.mapReferenceToDTO(reference);
  }

  /**
   * Get all recommendations using a specific strategy version.
   */
  async getRecommendationsForVersion(
    strategyId: string,
    version: number,
  ): Promise<VersionReferenceDTO[]> {
    const references = await prisma.strategyVersionReference.findMany({
      where: {
        strategyId,
        snapshotVersion: version,
        eventType: STRATEGY_EVENT_TYPE.RECOMMENDATION,
      },
      orderBy: { linkedAt: 'desc' },
    });

    return references.map((r) => this.mapReferenceToDTO(r));
  }

  /**
   * Get all rebalances using a specific strategy version.
   */
  async getRebalancesForVersion(
    strategyId: string,
    version: number,
  ): Promise<VersionReferenceDTO[]> {
    const references = await prisma.strategyVersionReference.findMany({
      where: {
        strategyId,
        snapshotVersion: version,
        eventType: STRATEGY_EVENT_TYPE.REBALANCE,
      },
      orderBy: { linkedAt: 'desc' },
    });

    return references.map((r) => this.mapReferenceToDTO(r));
  }

  /**
   * Get all events using a specific strategy version.
   */
  async getEventsForVersion(
    strategyId: string,
    version: number,
  ): Promise<VersionReferenceDTO[]> {
    const references = await prisma.strategyVersionReference.findMany({
      where: {
        strategyId,
        snapshotVersion: version,
      },
      orderBy: { linkedAt: 'desc' },
    });

    return references.map((r) => this.mapReferenceToDTO(r));
  }

  /**
   * Get the complete version history with changes.
   */
  async getVersionHistory(strategyId: string): Promise<VersionChangeRecordDTO[]> {
    const changes = await prisma.strategyVersionHistory.findMany({
      where: { strategyId },
      orderBy: { createdAt: 'desc' },
    });

    return changes.map((c) => this.mapChangeRecordToDTO(c));
  }

  /**
   * Get version changes between two specific versions.
   */
  async getChangesBetweenVersions(
    strategyId: string,
    fromVersion: number,
    toVersion: number,
  ): Promise<VersionChangeRecordDTO[]> {
    const changes = await prisma.strategyVersionHistory.findMany({
      where: {
        strategyId,
        fromVersion,
        toVersion,
      },
    });

    return changes.map((c) => this.mapChangeRecordToDTO(c));
  }

  /**
   * Replay audit - verify a recommendation was made with the correct version.
   */
  async verifyRecommendationVersion(
    recommendationId: string,
    expectedStrategyId: string,
    expectedVersion: number,
  ): Promise<boolean> {
    const reference = await prisma.strategyVersionReference.findFirst({
      where: {
        recommendationId,
        strategyId: expectedStrategyId,
        snapshotVersion: expectedVersion,
      },
    });

    return !!reference;
  }

  /**
   * Replay audit - verify a rebalance was executed with the correct version.
   */
  async verifyRebalanceVersion(
    rebalanceQueueId: string,
    expectedStrategyId: string,
    expectedVersion: number,
  ): Promise<boolean> {
    const reference = await prisma.strategyVersionReference.findFirst({
      where: {
        rebalanceQueueId,
        strategyId: expectedStrategyId,
        snapshotVersion: expectedVersion,
      },
    });

    return !!reference;
  }

  /**
   * Archive old versions (keep only last N versions).
   * This helps clean up while maintaining history.
   */
  async archiveOldVersions(strategyId: string, keepVersions = 10): Promise<number> {
    const allVersions = await prisma.strategySnapshot.findMany({
      where: { strategyId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true },
    });

    const toArchive = allVersions.slice(keepVersions);

    if (toArchive.length === 0) {
      return 0;
    }

    const archiveIds = toArchive.map((v) => v.id);

    const result = await prisma.strategySnapshot.updateMany({
      where: { id: { in: archiveIds } },
      data: { status: 'ARCHIVED' },
    });

    return result.count;
  }

  /**
   * Get statistics about version usage.
   */
  async getVersionStatistics(
    strategyId: string,
  ): Promise<{
    totalVersions: number;
    activeVersion: number;
    recommendationsCount: number;
    rebalancesCount: number;
    totalEventsCount: number;
  }> {
    const [totalVersions, activeVersion, recommendationsCount, rebalancesCount, totalEventsCount] =
      await Promise.all([
        prisma.strategySnapshot.count({ where: { strategyId } }),
        prisma.strategySnapshot.findFirst({
          where: { strategyId, status: 'ACTIVE' },
          select: { version: true },
        }),
        prisma.strategyVersionReference.count({
          where: { strategyId, eventType: STRATEGY_EVENT_TYPE.RECOMMENDATION },
        }),
        prisma.strategyVersionReference.count({
          where: { strategyId, eventType: STRATEGY_EVENT_TYPE.REBALANCE },
        }),
        prisma.strategyVersionReference.count({
          where: { strategyId },
        }),
      ]);

    return {
      totalVersions,
      activeVersion: activeVersion?.version ?? 0,
      recommendationsCount,
      rebalancesCount,
      totalEventsCount,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  private async recordVersionChange(
    strategyId: string,
    fromVersion: number,
    toVersion: number,
    changeType: VersionChangeType,
    reason: string,
    author: string | undefined,
    previousSnapshot: any,
    newSnapshot: any,
  ): Promise<void> {
    const versionChanges = {
      keyWeights: {
        from: previousSnapshot.keyWeights,
        to: newSnapshot.keyWeights,
      },
      riskParameters: {
        from: previousSnapshot.riskParameters,
        to: newSnapshot.riskParameters,
      },
      constraints: {
        from: previousSnapshot.constraints,
        to: newSnapshot.constraints,
      },
    };

    await prisma.strategyVersionHistory.create({
      data: {
        strategyId,
        versionChanges,
        fromVersion,
        toVersion,
        changeType,
        reason,
        author,
      },
    });
  }

  private detectChangeType(
    previousSnapshot: any,
    newSnapshot: any,
  ): VersionChangeType {
    const keyWeightsChanged =
      JSON.stringify(previousSnapshot.keyWeights) !== JSON.stringify(newSnapshot.keyWeights);
    const constraintsChanged =
      JSON.stringify(previousSnapshot.constraints) !== JSON.stringify(newSnapshot.constraints);
    const parametersChanged =
      JSON.stringify(previousSnapshot.riskParameters) !== JSON.stringify(newSnapshot.riskParameters);

    if (
      keyWeightsChanged &&
      !constraintsChanged &&
      !parametersChanged
    ) {
      return VERSION_CHANGE_TYPE.WEIGHTS_UPDATE;
    } else if (
      !keyWeightsChanged &&
      constraintsChanged &&
      !parametersChanged
    ) {
      return VERSION_CHANGE_TYPE.CONSTRAINTS_UPDATE;
    } else if (
      !keyWeightsChanged &&
      !constraintsChanged &&
      parametersChanged
    ) {
      return VERSION_CHANGE_TYPE.PARAMETERS_UPDATE;
    }

    return VERSION_CHANGE_TYPE.FULL_REVISION;
  }

  private mapToDTO(snapshot: any): StrategySnapshotDTO {
    return {
      id: snapshot.id,
      strategyId: snapshot.strategyId,
      version: snapshot.version,
      name: snapshot.name,
      description: snapshot.description,
      keyWeights: snapshot.keyWeights as Record<string, number>,
      riskParameters: snapshot.riskParameters as Record<string, unknown>,
      constraints: snapshot.constraints as Record<string, unknown>,
      status: snapshot.status,
      createdAt: snapshot.createdAt,
      supersededAt: snapshot.supersededAt,
      supersededByVersion: snapshot.supersededByVersion,
      changeReason: snapshot.changeReason,
      changeAuthor: snapshot.changeAuthor,
    };
  }

  private mapReferenceToDTO(reference: any): VersionReferenceDTO {
    return {
      id: reference.id,
      strategySnapshotId: reference.strategySnapshotId,
      strategyId: reference.strategyId,
      snapshotVersion: reference.snapshotVersion,
      recommendationId: reference.recommendationId,
      rebalanceQueueId: reference.rebalanceQueueId,
      eventType: reference.eventType,
      linkedAt: reference.linkedAt,
      linkedBy: reference.linkedBy,
    };
  }

  private mapChangeRecordToDTO(record: any): VersionChangeRecordDTO {
    return {
      id: record.id,
      strategyId: record.strategyId,
      versionChanges: record.versionChanges as Record<string, unknown>,
      fromVersion: record.fromVersion,
      toVersion: record.toVersion,
      changeType: record.changeType,
      reason: record.reason,
      author: record.author,
      createdAt: record.createdAt,
    };
  }
}

// Export singleton instance
export const strategySnapshotVersioningService = new StrategySnapshotVersioningService();
