/**
 * RebalanceSagaService
 *
 * Implements an idempotent rebalance execution saga with durable checkpoints.
 *
 * The saga tracks each rebalance attempt through a state machine:
 *
 *   INIT → QUOTE → APPROVAL → SUBMIT → CONFIRM → SNAPSHOT → COMPLETE
 *
 * Each phase has a unique idempotency key. If a worker crashes or times out
 * mid-execution, the saga can be resumed from the last durable checkpoint
 * without duplicating on-chain actions.
 *
 * Terminal states:
 *   - pending               — Saga created, not yet started
 *   - simulated             — Dry-run / quote phase completed
 *   - submitted             — Transaction submitted to network
 *   - confirmed             — Transaction confirmed on-chain
 *   - failed                — Unrecoverable failure
 *   - cancelled             — Cancelled by operator
 *   - requires_manual_review — Needs human intervention
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

// ── Saga state constants ────────────────────────────────────────────────────

export const SAGA_STATE = {
  PENDING: 'pending',
  SIMULATED: 'simulated',
  SUBMITTED: 'submitted',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  REQUIRES_MANUAL_REVIEW: 'requires_manual_review',
} as const;

export type SagaState = (typeof SAGA_STATE)[keyof typeof SAGA_STATE];

// ── Phase constants ─────────────────────────────────────────────────────────

export const SAGA_PHASE = {
  INIT: 'INIT',
  QUOTE: 'QUOTE',
  APPROVAL: 'APPROVAL',
  SUBMIT: 'SUBMIT',
  CONFIRM: 'CONFIRM',
  SNAPSHOT: 'SNAPSHOT',
  COMPLETE: 'COMPLETE',
} as const;

export type SagaPhase = (typeof SAGA_PHASE)[keyof typeof SAGA_PHASE];

// ── Checkpoint status ───────────────────────────────────────────────────────

export const CHECKPOINT_STATUS = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;

export type CheckpointStatus = (typeof CHECKPOINT_STATUS)[keyof typeof CHECKPOINT_STATUS];

// ── Failure classes (reuse from executor) ───────────────────────────────────

export const FAILURE_CLASS = {
  TRANSIENT: 'TRANSIENT',
  FEE_SEQUENCE: 'FEE_SEQUENCE',
  CONSTRAINT: 'CONSTRAINT',
  STALE_INTENT: 'STALE_INTENT',
  PERMANENT: 'PERMANENT',
} as const;

export type FailureClass = (typeof FAILURE_CLASS)[keyof typeof FAILURE_CLASS];

// ── DTOs ────────────────────────────────────────────────────────────────────

export interface RebalanceSagaDTO {
  id: string;
  queueEntryId: string;
  vaultId: string;
  state: SagaState;
  currentPhase: SagaPhase;
  quoteKey: string | null;
  approvalKey: string | null;
  submissionKey: string | null;
  confirmationKey: string | null;
  snapshotKey: string | null;
  checkpoint: Record<string, unknown> | null;
  transactionHash: string | null;
  feeBumpHash: string | null;
  innerTxXdr: string | null;
  lockedBy: string | null;
  lockedAt: Date | null;
  lockExpiresAt: Date | null;
  failureClass: FailureClass | null;
  failureReason: string | null;
  failureCount: number;
  maxRetries: number;
  reviewRequired: boolean;
  reviewReason: string | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface SagaCheckpointDTO {
  id: string;
  sagaId: string;
  phase: SagaPhase;
  idempotencyKey: string;
  status: CheckpointStatus;
  payload: Record<string, unknown> | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface SagaRetryDTO {
  id: string;
  sagaId: string;
  attemptNumber: number;
  phase: SagaPhase;
  reason: string;
  failureClass: FailureClass | null;
  error: string | null;
  createdAt: Date;
}

export interface SagaLockResult {
  acquired: boolean;
  saga: RebalanceSagaDTO | null;
  reason?: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class RebalanceSagaService {
  private readonly lockDurationMs = 5 * 60 * 1000; // 5 minutes

  /**
   * Create a new saga for a rebalance queue entry.
   * Generates idempotency keys for all phases up front.
   */
  async createSaga(
    queueEntryId: string,
    vaultId: string,
    options?: { maxRetries?: number },
  ): Promise<RebalanceSagaDTO> {
    const existing = await prisma.rebalanceSaga.findUnique({
      where: { queueEntryId },
    });

    if (existing) {
      return this.mapSagaToDTO(existing);
    }

    const saga = await prisma.rebalanceSaga.create({
      data: {
        queueEntryId,
        vaultId,
        state: SAGA_STATE.PENDING,
        currentPhase: SAGA_PHASE.INIT,
        quoteKey: this.generateIdempotencyKey('quote', queueEntryId),
        approvalKey: this.generateIdempotencyKey('approval', queueEntryId),
        submissionKey: this.generateIdempotencyKey('submission', queueEntryId),
        confirmationKey: this.generateIdempotencyKey('confirmation', queueEntryId),
        snapshotKey: this.generateIdempotencyKey('snapshot', queueEntryId),
        maxRetries: options?.maxRetries ?? 3,
      },
    });

    // Link saga to queue entry
    await prisma.rebalanceQueueEntry.update({
      where: { id: queueEntryId },
      data: { sagaId: saga.id },
    });

    return this.mapSagaToDTO(saga);
  }

  /**
   * Acquire a distributed lock on a saga.
   * Prevents concurrent workers from processing the same saga.
   */
  async acquireLock(
    sagaId: string,
    workerId: string,
  ): Promise<SagaLockResult> {
    const now = new Date();
    const saga = await prisma.rebalanceSaga.findUnique({
      where: { id: sagaId },
    });

    if (!saga) {
      return { acquired: false, saga: null, reason: 'Saga not found' };
    }

    // Check if already locked by another worker
    if (saga.lockedBy && saga.lockedBy !== workerId) {
      if (saga.lockExpiresAt && saga.lockExpiresAt > now) {
        return {
          acquired: false,
          saga: this.mapSagaToDTO(saga),
          reason: `Locked by ${saga.lockedBy} until ${saga.lockExpiresAt.toISOString()}`,
        };
      }
      // Lock expired — steal it
    }

    const updated = await prisma.rebalanceSaga.update({
      where: { id: sagaId },
      data: {
        lockedBy: workerId,
        lockedAt: now,
        lockExpiresAt: new Date(now.getTime() + this.lockDurationMs),
      },
    });

    return { acquired: true, saga: this.mapSagaToDTO(updated) };
  }

  /**
   * Release a lock on a saga.
   */
  async releaseLock(sagaId: string, workerId: string): Promise<void> {
    const saga = await prisma.rebalanceSaga.findUnique({
      where: { id: sagaId },
    });

    if (saga && saga.lockedBy === workerId) {
      await prisma.rebalanceSaga.update({
        where: { id: sagaId },
        data: {
          lockedBy: null,
          lockedAt: null,
          lockExpiresAt: null,
        },
      });
    }
  }

  /**
   * Record a checkpoint for a phase.
   * Idempotent: if the checkpoint already exists with the same key, it is not re-created.
   */
  async recordCheckpoint(
    sagaId: string,
    phase: SagaPhase,
    idempotencyKey: string,
    payload?: Record<string, unknown>,
  ): Promise<SagaCheckpointDTO> {
    const existing = await prisma.rebalanceSagaCheckpoint.findUnique({
      where: {
        sagaId_idempotencyKey: {
          sagaId,
          idempotencyKey,
        },
      },
    });

    if (existing) {
      return this.mapCheckpointToDTO(existing);
    }

    const checkpoint = await prisma.rebalanceSagaCheckpoint.create({
      data: {
        sagaId,
        phase,
        idempotencyKey,
        status: CHECKPOINT_STATUS.COMPLETED,
        payload: payload as any,
        completedAt: new Date(),
      },
    });

    // Update saga checkpoint data
    await prisma.rebalanceSaga.update({
      where: { id: sagaId },
      data: {
        currentPhase: phase,
        checkpoint: {
          phase,
          idempotencyKey,
          recordedAt: new Date().toISOString(),
          ...payload,
        } as any,
      },
    });

    return this.mapCheckpointToDTO(checkpoint);
  }

  /**
   * Mark a checkpoint as failed.
   */
  async failCheckpoint(
    sagaId: string,
    phase: SagaPhase,
    idempotencyKey: string,
    error: string,
  ): Promise<SagaCheckpointDTO> {
    const checkpoint = await prisma.rebalanceSagaCheckpoint.upsert({
      where: {
        sagaId_idempotencyKey: {
          sagaId,
          idempotencyKey,
        },
      },
      update: {
        status: CHECKPOINT_STATUS.FAILED,
        error,
        completedAt: new Date(),
      },
      create: {
        sagaId,
        phase,
        idempotencyKey,
        status: CHECKPOINT_STATUS.FAILED,
        error,
        completedAt: new Date(),
      },
    });

    return this.mapCheckpointToDTO(checkpoint);
  }

  /**
   * Record a retry attempt.
   */
  async recordRetry(
    sagaId: string,
    attemptNumber: number,
    phase: SagaPhase,
    reason: string,
    failureClass?: FailureClass,
    error?: string,
  ): Promise<SagaRetryDTO> {
    const retry = await prisma.rebalanceSagaRetry.create({
      data: {
        sagaId,
        attemptNumber,
        phase,
        reason,
        failureClass: failureClass ?? null,
        error: error ?? null,
      },
    });

    return this.mapRetryToDTO(retry);
  }

  /**
   * Transition the saga to a new state.
   */
  async transitionState(
    sagaId: string,
    newState: SagaState,
    options?: {
      failureClass?: FailureClass;
      failureReason?: string;
      reviewReason?: string;
      transactionHash?: string;
      feeBumpHash?: string;
      innerTxXdr?: string;
    },
  ): Promise<RebalanceSagaDTO> {
    const now = new Date();
    const isTerminal = (
      newState === SAGA_STATE.FAILED ||
      newState === SAGA_STATE.CANCELLED ||
      newState === SAGA_STATE.CONFIRMED ||
      newState === SAGA_STATE.REQUIRES_MANUAL_REVIEW
    );

    const saga = await prisma.rebalanceSaga.update({
      where: { id: sagaId },
      data: {
        state: newState,
        failureClass: options?.failureClass ?? undefined,
        failureReason: options?.failureReason ?? undefined,
        reviewRequired: newState === SAGA_STATE.REQUIRES_MANUAL_REVIEW,
        reviewReason: options?.reviewReason ?? undefined,
        transactionHash: options?.transactionHash ?? undefined,
        feeBumpHash: options?.feeBumpHash ?? undefined,
        innerTxXdr: options?.innerTxXdr ?? undefined,
        completedAt: isTerminal ? now : undefined,
      },
    });

    // When the saga reaches a terminal state, sync the queue entry so the
    // failure/review state is visible in the queue and the processor stops
    // spinning retries on a dead job (acceptance: "A failed transaction
    // records the reason and does not silently disappear from the queue").
    if (isTerminal) {
      await this.syncQueueEntryWithTerminalState(saga);
    }

    return this.mapSagaToDTO(saga);
  }

  /**
   * Increment failure count and determine if retry is allowed.
   */
  async recordFailure(
    sagaId: string,
    failureClass: FailureClass,
    failureReason: string,
  ): Promise<{ shouldRetry: boolean; saga: RebalanceSagaDTO }> {
    const saga = await prisma.rebalanceSaga.findUniqueOrThrow({
      where: { id: sagaId },
    });

    const newFailureCount = saga.failureCount + 1;
    const shouldRetry = newFailureCount <= saga.maxRetries;

    const updated = await prisma.rebalanceSaga.update({
      where: { id: sagaId },
      data: {
        failureCount: newFailureCount,
        failureClass,
        failureReason,
        state: shouldRetry ? SAGA_STATE.PENDING : SAGA_STATE.FAILED,
        completedAt: shouldRetry ? undefined : new Date(),
      },
    });

    return { shouldRetry, saga: this.mapSagaToDTO(updated) };
  }

  /**
   * Get the current saga state for a queue entry.
   */
  async getSagaByQueueEntry(queueEntryId: string): Promise<RebalanceSagaDTO | null> {
    const saga = await prisma.rebalanceSaga.findUnique({
      where: { queueEntryId },
    });

    return saga ? this.mapSagaToDTO(saga) : null;
  }

  /**
   * Get saga by ID with checkpoints and retries.
   */
  async getSagaWithHistory(sagaId: string): Promise<{
    saga: RebalanceSagaDTO;
    checkpoints: SagaCheckpointDTO[];
    retries: SagaRetryDTO[];
  } | null> {
    const saga = await prisma.rebalanceSaga.findUnique({
      where: { id: sagaId },
      include: {
        checkpoints: { orderBy: { createdAt: 'asc' } },
        retries: { orderBy: { attemptNumber: 'asc' } },
      },
    });

    if (!saga) return null;

    return {
      saga: this.mapSagaToDTO(saga),
      checkpoints: saga.checkpoints.map((c) => this.mapCheckpointToDTO(c)),
      retries: saga.retries.map((r) => this.mapRetryToDTO(r)),
    };
  }

  /**
   * List sagas with optional filters.
   */
  async listSagas(options?: {
    vaultId?: string;
    state?: SagaState;
    limit?: number;
    offset?: number;
  }): Promise<{ sagas: RebalanceSagaDTO[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (options?.vaultId) where.vaultId = options.vaultId;
    if (options?.state) where.state = options.state;

    const total = await prisma.rebalanceSaga.count({ where });
    const sagas = await prisma.rebalanceSaga.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: options?.limit ?? 50,
      skip: options?.offset ?? 0,
    });

    return {
      sagas: sagas.map((s) => this.mapSagaToDTO(s)),
      total,
    };
  }

  /**
   * Find sagas that need recovery (stuck in non-terminal state with expired lock).
   */
  async findStuckSagas(): Promise<RebalanceSagaDTO[]> {
    const now = new Date();
    const sagas = await prisma.rebalanceSaga.findMany({
      where: {
        state: {
          in: [SAGA_STATE.PENDING, SAGA_STATE.SIMULATED, SAGA_STATE.SUBMITTED],
        },
        OR: [
          { lockExpiresAt: { lt: now } },
          { lockedBy: null },
        ],
      },
    });

    return sagas.map((s) => this.mapSagaToDTO(s));
  }

  /**
   * Cancel a saga.
   */
  async cancelSaga(sagaId: string, reason: string): Promise<RebalanceSagaDTO> {
    return this.transitionState(sagaId, SAGA_STATE.CANCELLED, {
      failureReason: reason,
    });
  }

  /**
   * Mark a saga as requiring manual review.
   */
  async requireManualReview(
    sagaId: string,
    reason: string,
  ): Promise<RebalanceSagaDTO> {
    return this.transitionState(sagaId, SAGA_STATE.REQUIRES_MANUAL_REVIEW, {
      reviewReason: reason,
    });
  }

  /**
   * Resolve a manual review (operator decision).
   */
  async resolveManualReview(
    sagaId: string,
    decision: 'retry' | 'cancel',
    reviewedBy: string,
    reason?: string,
  ): Promise<RebalanceSagaDTO> {
    const saga = await prisma.rebalanceSaga.findUniqueOrThrow({
      where: { id: sagaId },
    });

    if (saga.state !== SAGA_STATE.REQUIRES_MANUAL_REVIEW) {
      throw new Error(`Saga ${sagaId} is not in requires_manual_review state`);
    }

    const updated = await prisma.rebalanceSaga.update({
      where: { id: sagaId },
      data: {
        state: decision === 'retry' ? SAGA_STATE.PENDING : SAGA_STATE.CANCELLED,
        reviewedAt: new Date(),
        reviewedBy,
        reviewRequired: false,
        reviewReason: reason ?? saga.reviewReason,
        completedAt: decision === 'cancel' ? new Date() : undefined,
      },
    });

    // Sync queue entry: retry → back to PENDING so the processor picks it up;
    // cancel → terminal CANCELLED so it stays out of the retry pool.
    await prisma.rebalanceQueueEntry.update({
      where: { id: saga.queueEntryId },
      data:
        decision === 'retry'
          ? {
              status: 'PENDING',
              lastError: null,
              nextRetryAt: new Date(),
              completedAt: undefined,
            }
          : {
              status: 'CANCELLED',
              lastError: reason ?? saga.reviewReason ?? 'Cancelled via review',
              completedAt: new Date(),
            },
    });

    return this.mapSagaToDTO(updated);
  }

  /**
   * Resume a saga from its last checkpoint.
   * Returns the phase to resume from, or null if the saga is terminal.
   */
  async resumeSaga(sagaId: string): Promise<{
    saga: RebalanceSagaDTO;
    resumeFromPhase: SagaPhase | null;
  }> {
    const saga = await prisma.rebalanceSaga.findUniqueOrThrow({
      where: { id: sagaId },
    });

    const dto = this.mapSagaToDTO(saga);

    // Terminal states cannot be resumed
    if (
      dto.state === SAGA_STATE.FAILED ||
      dto.state === SAGA_STATE.CANCELLED ||
      dto.state === SAGA_STATE.CONFIRMED ||
      dto.state === SAGA_STATE.REQUIRES_MANUAL_REVIEW
    ) {
      return { saga: dto, resumeFromPhase: null };
    }

    // Determine resume phase based on current phase
    let resumeFromPhase: SagaPhase = SAGA_PHASE.QUOTE;
    switch (dto.currentPhase) {
      case SAGA_PHASE.INIT:
        resumeFromPhase = SAGA_PHASE.QUOTE;
        break;
      case SAGA_PHASE.QUOTE:
        resumeFromPhase = SAGA_PHASE.APPROVAL;
        break;
      case SAGA_PHASE.APPROVAL:
        resumeFromPhase = SAGA_PHASE.SUBMIT;
        break;
      case SAGA_PHASE.SUBMIT:
        resumeFromPhase = SAGA_PHASE.CONFIRM;
        break;
      case SAGA_PHASE.CONFIRM:
        resumeFromPhase = SAGA_PHASE.SNAPSHOT;
        break;
      case SAGA_PHASE.SNAPSHOT:
        resumeFromPhase = SAGA_PHASE.COMPLETE;
        break;
      default:
        resumeFromPhase = SAGA_PHASE.QUOTE;
    }

    return { saga: dto, resumeFromPhase };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Sync the queue entry's status when its saga reaches a terminal state.
   *
   * Maps saga terminal states to queue-entry terminal states so failures and
   * manual-review jobs are clearly visible in the queue (and the processor
   * stops picking them up as retryable).
   */
  private async syncQueueEntryWithTerminalState(saga: any): Promise<void> {
    const REBALANCE_STATUS = {
      PENDING: 'PENDING',
      PROCESSING: 'PROCESSING',
      PARTIAL: 'PARTIAL',
      COMPLETED: 'COMPLETED',
      FAILED: 'FAILED',
      CANCELLED: 'CANCELLED',
    } as const;

    let status: string;
    let lastError: string | null = null;

    switch (saga.state) {
      case SAGA_STATE.CONFIRMED:
        status = REBALANCE_STATUS.COMPLETED;
        break;
      case SAGA_STATE.CANCELLED:
        status = REBALANCE_STATUS.CANCELLED;
        lastError = saga.failureReason ?? saga.reviewReason ?? 'Cancelled';
        break;
      case SAGA_STATE.REQUIRES_MANUAL_REVIEW:
        status = REBALANCE_STATUS.FAILED;
        lastError = saga.reviewReason ?? saga.failureReason;
        break;
      case SAGA_STATE.FAILED:
        status = REBALANCE_STATUS.FAILED;
        lastError = saga.failureReason;
        break;
      default:
        return; // Non-terminal saga — no queue sync
    }

    await prisma.rebalanceQueueEntry.update({
      where: { id: saga.queueEntryId },
      data: {
        status,
        lastError,
        completedAt: new Date(),
      },
    });
  }

  private generateIdempotencyKey(phase: string, queueEntryId: string): string {
    const data = JSON.stringify({ phase, queueEntryId, nonce: crypto.randomUUID() });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private mapSagaToDTO(saga: any): RebalanceSagaDTO {
    return {
      id: saga.id,
      queueEntryId: saga.queueEntryId,
      vaultId: saga.vaultId,
      state: saga.state as SagaState,
      currentPhase: saga.currentPhase as SagaPhase,
      quoteKey: saga.quoteKey,
      approvalKey: saga.approvalKey,
      submissionKey: saga.submissionKey,
      confirmationKey: saga.confirmationKey,
      snapshotKey: saga.snapshotKey,
      checkpoint: saga.checkpoint as Record<string, unknown> | null,
      transactionHash: saga.transactionHash,
      feeBumpHash: saga.feeBumpHash,
      innerTxXdr: saga.innerTxXdr,
      lockedBy: saga.lockedBy,
      lockedAt: saga.lockedAt,
      lockExpiresAt: saga.lockExpiresAt,
      failureClass: saga.failureClass as FailureClass | null,
      failureReason: saga.failureReason,
      failureCount: saga.failureCount,
      maxRetries: saga.maxRetries,
      reviewRequired: saga.reviewRequired,
      reviewReason: saga.reviewReason,
      reviewedAt: saga.reviewedAt,
      reviewedBy: saga.reviewedBy,
      createdAt: saga.createdAt,
      updatedAt: saga.updatedAt,
      completedAt: saga.completedAt,
    };
  }

  private mapCheckpointToDTO(cp: any): SagaCheckpointDTO {
    return {
      id: cp.id,
      sagaId: cp.sagaId,
      phase: cp.phase as SagaPhase,
      idempotencyKey: cp.idempotencyKey,
      status: cp.status as CheckpointStatus,
      payload: cp.payload as Record<string, unknown> | null,
      error: cp.error,
      createdAt: cp.createdAt,
      completedAt: cp.completedAt,
    };
  }

  private mapRetryToDTO(r: any): SagaRetryDTO {
    return {
      id: r.id,
      sagaId: r.sagaId,
      attemptNumber: r.attemptNumber,
      phase: r.phase as SagaPhase,
      reason: r.reason,
      failureClass: r.failureClass as FailureClass | null,
      error: r.error,
      createdAt: r.createdAt,
    };
  }
}

// Export singleton instance
export const rebalanceSagaService = new RebalanceSagaService();