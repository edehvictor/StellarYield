import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { EXECUTION_TYPE, ExecutionType, REBALANCE_STATUS, RebalanceStatus } from '../queues/types';

const prisma = new PrismaClient();

/**
 * Rebalance queue entry for deferred execution with partial fill support.
 * Supports retry scheduling and duplicate prevention.
 */
export interface RebalanceQueueEntryDTO {
  id: string;
  vaultId: string;
  status: RebalanceStatus;
  executionType: ExecutionType;
  targetAllocations: Record<string, number>;
  currentAllocations: Record<string, number>;
  executionStrategy: Record<string, unknown>;
  partiallyExecuted: boolean;
  partialFillAmount: number;
  intentHash: string;
  attemptCount: number;
  maxRetries: number;
  nextRetryAt: Date | null;
  deferredUntil: Date | null;
  followUpEntryId: string | null;
  lastError: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RebalanceExecutionResult {
  queueEntryId: string;
  totalExecuted: number;
  expectedAmount: number;
  filledPercentage: number;
  transactionHash?: string;
  executionDetails: Record<string, unknown>;
}

export interface PartialFillConfig {
  minFillPercentage: number;
  maxRetries: number;
  retryDelayMs: number;
  deferralThreshold?: number; // If fill% < this, defer
}

// ── Queue health summary (#1076) ────────────────────────────────────────────
//
// Raw job totals (e.g. "12 pending, 3 failed") don't tell an operator
// whether a backlog is healthy: a "pending" entry might be a fresh job
// that hasn't been picked up yet, one waiting out a retry backoff delay,
// or one that has already failed once and is due for another attempt
// right now. Likewise a "failed" entry might still have retries left, or
// have exhausted them entirely (effectively dead-lettered). This summary
// distinguishes all of those states from the same underlying fields, with
// no schema changes required.

export interface QueueHealthSnapshot {
  /** Currently being executed. */
  active: number;
  /** Never attempted yet, and not scheduled for later — ready to run now. */
  waiting: number;
  /** Scheduled for later (a future nextRetryAt or deferredUntil) — not yet due. */
  delayed: number;
  /** Has failed at least once before and is now due for another attempt. */
  retrying: number;
  /** Terminally failed, but with retries still remaining on paper (e.g. intent expired before exhausting attempts). */
  failed: number;
  /** Terminally failed after exhausting all retry attempts. */
  deadLettered: number;
  /** Sum of the six buckets above. */
  total: number;
  generatedAt: string;
}

/** Minimal fields needed to classify one queue entry's health bucket. */
export interface QueueEntrySnapshot {
  status: RebalanceStatus;
  executionType: ExecutionType;
  attemptCount: number;
  maxRetries: number;
  nextRetryAt: Date | null;
  deferredUntil: Date | null;
}

/**
 * Classifies a set of queue entries into a health summary distinguishing
 * waiting, delayed, retrying, active, failed, and dead-lettered states
 * (#1076). Pure function — no DB access — so it can be tested directly
 * against synthetic snapshots (empty, overloaded, mixed-state).
 */
export function summarizeQueueHealth(
  entries: QueueEntrySnapshot[],
  now: Date = new Date(),
): QueueHealthSnapshot {
  let active = 0;
  let waiting = 0;
  let delayed = 0;
  let retrying = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const entry of entries) {
    if (entry.status === REBALANCE_STATUS.PROCESSING) {
      active++;
      continue;
    }

    if (entry.status === REBALANCE_STATUS.FAILED) {
      if (entry.attemptCount >= entry.maxRetries) {
        deadLettered++;
      } else {
        failed++;
      }
      continue;
    }

    if (entry.status === REBALANCE_STATUS.PENDING) {
      const scheduledInFuture =
        (entry.nextRetryAt !== null && entry.nextRetryAt.getTime() > now.getTime()) ||
        (entry.executionType === EXECUTION_TYPE.DEFERRED &&
          entry.deferredUntil !== null &&
          entry.deferredUntil.getTime() > now.getTime());

      if (scheduledInFuture) {
        delayed++;
      } else if (entry.attemptCount > 0) {
        retrying++;
      } else {
        waiting++;
      }
      continue;
    }

    // PARTIAL / COMPLETED / CANCELLED are outside this backlog-health
    // picture and are intentionally not counted in any bucket.
  }

  return {
    active,
    waiting,
    delayed,
    retrying,
    failed,
    deadLettered,
    total: active + waiting + delayed + retrying + failed + deadLettered,
    generatedAt: now.toISOString(),
  };
}

/**
 * RebalanceQueueService
 *
 * Manages deferred rebalance execution with support for partial fills,
 * retries, and safeguards against duplicate/conflicting entries.
 *
 * Security: All intents are hashed and validated for replay prevention.
 * Idempotency: Duplicate intents for the same vault are prevented.
 */
export class RebalanceQueueService {
  private defaultPartialFillConfig: PartialFillConfig = {
    minFillPercentage: 50,
    maxRetries: 3,
    retryDelayMs: 60000, // 1 minute
    deferralThreshold: 75, // Defer if < 75% can be filled
  };

  /**
   * Enqueue a rebalance request.
   * Prevents duplicate entries by checking intent hash.
   */
  async enqueueRebalance(
    vaultId: string,
    targetAllocations: Record<string, number>,
    currentAllocations: Record<string, number>,
    executionStrategy: Record<string, unknown>,
    options?: {
      triggeredBy?: string;
      intentValidUntil?: Date;
      maxRetries?: number;
    },
  ): Promise<RebalanceQueueEntryDTO> {
    const intentHash = this.generateIntentHash(vaultId, targetAllocations);

    // Check for existing pending entry with same intent
    const existingEntry = await prisma.rebalanceQueueEntry.findUnique({
      where: {
        intentHash_vaultId: {
          intentHash,
          vaultId,
        },
      },
    });

    if (existingEntry && existingEntry.status === REBALANCE_STATUS.PENDING) {
      throw new Error(
        `Duplicate rebalance intent for vault ${vaultId}. Existing queue entry: ${existingEntry.id}`,
      );
    }

    const entry = await prisma.rebalanceQueueEntry.create({
      data: {
        vaultId,
        status: REBALANCE_STATUS.PENDING,
        executionType: EXECUTION_TYPE.FULL,
        targetAllocations,
        currentAllocations,
        executionStrategy: executionStrategy as any,
        intentHash,
        intentValidUntil: options?.intentValidUntil || new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        maxRetries: options?.maxRetries ?? this.defaultPartialFillConfig.maxRetries,
        triggeredBy: options?.triggeredBy,
      },
    });

    return this.mapToDTO(entry);
  }

  /**
   * Mark a queue entry as processing.
   */
  async markAsProcessing(queueEntryId: string): Promise<RebalanceQueueEntryDTO> {
    const entry = await prisma.rebalanceQueueEntry.update({
      where: { id: queueEntryId },
      data: {
        status: REBALANCE_STATUS.PROCESSING,
      },
    });

    return this.mapToDTO(entry);
  }

  /**
   * Record a partial execution result.
   * Creates a follow-up queue entry if needed.
   */
  async recordPartialExecution(
    queueEntryId: string,
    result: RebalanceExecutionResult,
    config?: Partial<PartialFillConfig>,
  ): Promise<RebalanceQueueEntryDTO> {
    const finalConfig = { ...this.defaultPartialFillConfig, ...config };

    const queueEntry = await prisma.rebalanceQueueEntry.findUniqueOrThrow({
      where: { id: queueEntryId },
    });

    // Record execution history
    await prisma.rebalanceHistory.create({
      data: {
        queueEntryId,
        vaultId: queueEntry.vaultId,
        executionType: EXECUTION_TYPE.PARTIAL,
        executionResult: result.executionDetails as any,
        totalExecuted: result.totalExecuted,
        expectedAmount: result.expectedAmount,
        filledPercentage: result.filledPercentage,
        transactionHash: result.transactionHash,
        completedAt: new Date(),
      },
    });

    let newStatus: RebalanceStatus = REBALANCE_STATUS.PARTIAL;
    let followUpEntryId: string | null = null;

    // Determine if we should defer or retry
    if (result.filledPercentage < finalConfig.minFillPercentage) {
      // Below minimum fill, mark as failed
      newStatus = REBALANCE_STATUS.FAILED;
    } else if (result.filledPercentage < (finalConfig.deferralThreshold ?? 100)) {
      // Partial fill below threshold, create deferred follow-up
      const followUpEntry = await this.createDeferredFollowUp(
        queueEntry,
        result.totalExecuted,
        finalConfig,
      );
      followUpEntryId = followUpEntry.id;
      newStatus = REBALANCE_STATUS.PARTIAL;
    } else {
      // Full execution completed
      newStatus = REBALANCE_STATUS.COMPLETED;
    }

    const updatedEntry = await prisma.rebalanceQueueEntry.update({
      where: { id: queueEntryId },
      data: {
        status: newStatus,
        partiallyExecuted: result.filledPercentage < 100,
        partialFillAmount: result.totalExecuted,
        followUpEntryId,
        completedAt: newStatus === REBALANCE_STATUS.COMPLETED ? new Date() : undefined,
      },
    });

    return this.mapToDTO(updatedEntry);
  }

  /**
   * Record a failed execution attempt and schedule retry if needed.
   */
  async recordFailedAttempt(
    queueEntryId: string,
    error: string,
    config?: Partial<PartialFillConfig>,
  ): Promise<RebalanceQueueEntryDTO> {
    const finalConfig = { ...this.defaultPartialFillConfig, ...config };

    const entry = await prisma.rebalanceQueueEntry.findUniqueOrThrow({
      where: { id: queueEntryId },
    });

    // Validate intent expiry
    if (entry.intentValidUntil < new Date()) {
      const failedEntry = await prisma.rebalanceQueueEntry.update({
        where: { id: queueEntryId },
        data: {
          status: REBALANCE_STATUS.FAILED,
          lastError: 'Intent expired - replay prevention triggered',
          completedAt: new Date(),
        },
      });
      return this.mapToDTO(failedEntry);
    }

    const nextAttempt = entry.attemptCount + 1;
    const shouldRetry = nextAttempt <= finalConfig.maxRetries;

    const nextRetryAt = shouldRetry
      ? new Date(Date.now() + finalConfig.retryDelayMs * nextAttempt) // Exponential backoff
      : null;

    const updatedEntry = await prisma.rebalanceQueueEntry.update({
      where: { id: queueEntryId },
      data: {
        status: shouldRetry ? REBALANCE_STATUS.PENDING : REBALANCE_STATUS.FAILED,
        attemptCount: nextAttempt,
        nextRetryAt,
        lastError: error,
        completedAt: !shouldRetry ? new Date() : undefined,
      },
    });

    return this.mapToDTO(updatedEntry);
  }

  /**
   * Get all pending entries ready for retry.
   */
  async getPendingRetries(): Promise<RebalanceQueueEntryDTO[]> {
    const now = new Date();

    const entries = await prisma.rebalanceQueueEntry.findMany({
      where: {
        status: REBALANCE_STATUS.PENDING,
        nextRetryAt: {
          lte: now,
        },
      },
      orderBy: {
        nextRetryAt: 'asc',
      },
    });

    return entries.map((e) => this.mapToDTO(e));
  }

  /**
   * Get all deferred entries ready for processing.
   */
  async getDeferredEntries(): Promise<RebalanceQueueEntryDTO[]> {
    const now = new Date();

    const entries = await prisma.rebalanceQueueEntry.findMany({
      where: {
        executionType: EXECUTION_TYPE.DEFERRED,
        deferredUntil: {
          lte: now,
        },
      },
      orderBy: {
        deferredUntil: 'asc',
      },
    });

    return entries.map((e) => this.mapToDTO(e));
  }

  /**
   * Get queue status for a specific vault.
   */
  async getQueueStatus(vaultId: string): Promise<{
    pendingCount: number;
    processingCount: number;
    partialCount: number;
    failedCount: number;
    deferredCount: number;
  }> {
    const [pending, processing, partial, failed, deferred] = await Promise.all([
      prisma.rebalanceQueueEntry.count({
        where: { vaultId, status: REBALANCE_STATUS.PENDING },
      }),
      prisma.rebalanceQueueEntry.count({
        where: { vaultId, status: REBALANCE_STATUS.PROCESSING },
      }),
      prisma.rebalanceQueueEntry.count({
        where: { vaultId, status: REBALANCE_STATUS.PARTIAL },
      }),
      prisma.rebalanceQueueEntry.count({
        where: { vaultId, status: REBALANCE_STATUS.FAILED },
      }),
      prisma.rebalanceQueueEntry.count({
        where: { vaultId, executionType: EXECUTION_TYPE.DEFERRED },
      }),
    ]);

    return { pendingCount: pending, processingCount: processing, partialCount: partial, failedCount: failed, deferredCount: deferred };
  }

  /**
   * Summarizes rebalance-queue backlog health (#1076): waiting, delayed,
   * retrying, active, failed, and dead-lettered counts, optionally scoped
   * to one vault. Separates a job simply scheduled for later (delayed)
   * from one that already failed once and is now due for another attempt
   * (retrying), and separates a terminal failure that still had retries
   * on paper — e.g. its intent expired first — (failed) from one that
   * exhausted every retry attempt (deadLettered).
   */
  async getQueueHealthSummary(
    vaultId?: string,
    now: Date = new Date(),
  ): Promise<QueueHealthSnapshot> {
    const entries = await prisma.rebalanceQueueEntry.findMany({
      where: {
        ...(vaultId ? { vaultId } : {}),
        status: {
          in: [REBALANCE_STATUS.PENDING, REBALANCE_STATUS.PROCESSING, REBALANCE_STATUS.FAILED],
        },
      },
      select: {
        status: true,
        executionType: true,
        attemptCount: true,
        maxRetries: true,
        nextRetryAt: true,
        deferredUntil: true,
      },
    });

    return summarizeQueueHealth(entries, now);
  }

  /**
   * Mark entry as completed.
   */
  async markAsCompleted(queueEntryId: string, txHash?: string): Promise<RebalanceQueueEntryDTO> {
    await prisma.rebalanceHistory.create({
      data: {
        queueEntryId,
        vaultId: (await prisma.rebalanceQueueEntry.findUniqueOrThrow({ where: { id: queueEntryId } })).vaultId,
        executionType: EXECUTION_TYPE.FULL,
        executionResult: { status: 'completed' },
        totalExecuted: 100,
        expectedAmount: 100,
        filledPercentage: 100,
        transactionHash: txHash,
        completedAt: new Date(),
      },
    });

    const entry = await prisma.rebalanceQueueEntry.update({
      where: { id: queueEntryId },
      data: {
        status: REBALANCE_STATUS.COMPLETED,
        completedAt: new Date(),
      },
    });

    return this.mapToDTO(entry);
  }

  /**
   * Cancel a queue entry.
   */
  async cancelEntry(queueEntryId: string, reason: string): Promise<RebalanceQueueEntryDTO> {
    const entry = await prisma.rebalanceQueueEntry.update({
      where: { id: queueEntryId },
      data: {
        status: REBALANCE_STATUS.CANCELLED,
        lastError: reason,
        completedAt: new Date(),
      },
    });

    return this.mapToDTO(entry);
  }

  /**
   * Get execution history for a vault.
   */
  async getExecutionHistory(
    vaultId: string,
    limit = 50,
  ): Promise<Array<{
    id: string;
    vaultId: string;
    executionType: string;
    filledPercentage: number;
    totalExecuted: number;
    completedAt: Date;
    transactionHash: string | null;
  }>> {
    return prisma.rebalanceHistory.findMany({
      where: { vaultId },
      orderBy: { completedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        vaultId: true,
        executionType: true,
        filledPercentage: true,
        totalExecuted: true,
        completedAt: true,
        transactionHash: true,
      },
    });
  }

  /**
   * Prevent conflicting queue entries.
   * Validates that no overlapping allocations are in progress.
   */
  async validateNoConflictingEntries(
    vaultId: string,
    targetAllocations: Record<string, number>,
  ): Promise<boolean> {
    const activeEntries = await prisma.rebalanceQueueEntry.findMany({
      where: {
        vaultId,
        status: {
          in: [REBALANCE_STATUS.PENDING, REBALANCE_STATUS.PROCESSING, REBALANCE_STATUS.PARTIAL],
        },
      },
    });

    // Check for any overlapping allocations
    for (const entry of activeEntries) {
      const existing = entry.targetAllocations as Record<string, number>;
      const keys = new Set([...Object.keys(existing), ...Object.keys(targetAllocations)]);

      for (const key of keys) {
        if (existing[key] !== targetAllocations[key]) {
          return false; // Conflicting allocation detected
        }
      }
    }

    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  private async createDeferredFollowUp(
    originalEntry: any,
    executedAmount: number,
    config: PartialFillConfig,
  ): Promise<any> {
    const currentAllocations = originalEntry.currentAllocations as Record<string, number>;
    const updatedAllocations = { ...currentAllocations };

    // Update current allocations based on executed amount
    for (const key in updatedAllocations) {
      updatedAllocations[key] -= (updatedAllocations[key] * executedAmount) / 100;
    }

    const followUpEntry = await prisma.rebalanceQueueEntry.create({
      data: {
        vaultId: originalEntry.vaultId,
        status: REBALANCE_STATUS.PENDING,
        executionType: EXECUTION_TYPE.DEFERRED,
        targetAllocations: originalEntry.targetAllocations,
        currentAllocations: updatedAllocations,
        executionStrategy: originalEntry.executionStrategy as any,
        partiallyExecuted: true,
        partialFillAmount: 0,
        intentHash: this.generateIntentHash(
          originalEntry.vaultId,
          originalEntry.targetAllocations as Record<string, number>,
        ),
        intentValidUntil: originalEntry.intentValidUntil,
        maxRetries: originalEntry.maxRetries,
        deferredReason: 'Partial execution - follow-up from ' + originalEntry.id,
        deferredUntil: new Date(Date.now() + config.retryDelayMs),
        triggeredBy: originalEntry.triggeredBy,
      },
    });

    return followUpEntry;
  }

  private generateIntentHash(vaultId: string, targetAllocations: Record<string, number>): string {
    const data = JSON.stringify({ vaultId, allocations: targetAllocations });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private mapToDTO(entry: any): RebalanceQueueEntryDTO {
    return {
      id: entry.id,
      vaultId: entry.vaultId,
      status: entry.status,
      executionType: entry.executionType,
      targetAllocations: entry.targetAllocations as Record<string, number>,
      currentAllocations: entry.currentAllocations as Record<string, number>,
      executionStrategy: entry.executionStrategy as Record<string, unknown>,
      partiallyExecuted: entry.partiallyExecuted,
      partialFillAmount: entry.partialFillAmount,
      intentHash: entry.intentHash,
      attemptCount: entry.attemptCount,
      maxRetries: entry.maxRetries,
      nextRetryAt: entry.nextRetryAt,
      deferredUntil: entry.deferredUntil,
      followUpEntryId: entry.followUpEntryId,
      lastError: entry.lastError,
      completedAt: entry.completedAt,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }
}

// Export singleton instance
export const rebalanceQueueService = new RebalanceQueueService();
