/**
 * RebalanceSagaExecutor
 *
 * Orchestrates the idempotent rebalance execution saga by driving the
 * RebalanceSagaService state machine through each phase:
 *
 *   QUOTE → APPROVAL → SUBMIT → CONFIRM → SNAPSHOT → COMPLETE
 *
 * Each phase records a durable checkpoint with a unique idempotency key.
 * If a worker crashes or times out, the saga can be resumed from the last
 * checkpoint without duplicating on-chain actions.
 */

import {
  rebalanceSagaService,
  SAGA_STATE,
  SAGA_PHASE,
  FAILURE_CLASS,
  type RebalanceSagaDTO,
  type SagaPhase,
  type FailureClass,
} from './rebalanceSagaService';
import {
  rebalanceExecutorService,
  type ExecutionAttempt,
} from './rebalanceExecutorService';
import type { RebalanceQueueEntryDTO } from './rebalanceQueueService';

export interface SagaExecutionOptions {
  workerId: string;
  /** Simulate a timeout at a specific phase (for testing) */
  simulateTimeoutAt?: SagaPhase;
  /** Simulate a failure at a specific phase (for testing) */
  simulateFailureAt?: SagaPhase;
  /** Simulate a duplicate submission (for testing) */
  simulateDuplicate?: boolean;
}

export interface SagaExecutionOutcome {
  saga: RebalanceSagaDTO;
  completed: boolean;
  resumedFromPhase: SagaPhase | null;
  transactionHash?: string;
  error?: string;
}

/**
 * Execute a rebalance queue entry through the saga state machine.
 */
export async function executeRebalanceSaga(
  entry: RebalanceQueueEntryDTO,
  options: SagaExecutionOptions,
): Promise<SagaExecutionOutcome> {
  // ── 1. Create or fetch saga ─────────────────────────────────────────────
  const saga = await rebalanceSagaService.createSaga(entry.id, entry.vaultId);

  // ── 2. Acquire distributed lock ─────────────────────────────────────────
  const lockResult = await rebalanceSagaService.acquireLock(saga.id, options.workerId);
  if (!lockResult.acquired || !lockResult.saga) {
    return {
      saga: lockResult.saga ?? saga,
      completed: false,
      resumedFromPhase: null,
      error: lockResult.reason ?? 'Failed to acquire lock',
    };
  }

  const lockedSaga = lockResult.saga;
  let resumeFromPhase: SagaPhase | null = null;

  try {
    // ── 3. Resume from last checkpoint ────────────────────────────────────
    const resume = await rebalanceSagaService.resumeSaga(lockedSaga.id);
    if (!resume.resumeFromPhase) {
      return {
        saga: resume.saga,
        completed: resume.saga.state === SAGA_STATE.CONFIRMED,
        resumedFromPhase: null,
        transactionHash: resume.saga.transactionHash ?? undefined,
      };
    }

    resumeFromPhase = resume.resumeFromPhase;

    // ── 4. Execute phases ─────────────────────────────────────────────────
    let currentPhase = resumeFromPhase;
    let transactionHash: string | undefined;
    let feeBumpHash: string | undefined;
    let innerTxXdr: string | undefined;

    // QUOTE phase — dry-run validation
    if (currentPhase === SAGA_PHASE.QUOTE) {
      if (options.simulateTimeoutAt === SAGA_PHASE.QUOTE) {
        throw new Error('Simulated timeout during QUOTE phase');
      }
      if (options.simulateFailureAt === SAGA_PHASE.QUOTE) {
        throw new Error('Simulated failure during QUOTE phase');
      }

      const dry = await rebalanceExecutorService.dryRun(entry);
      if (!dry.viable) {
        const failureClass = dry.reason?.includes('expired')
          ? FAILURE_CLASS.STALE_INTENT
          : FAILURE_CLASS.CONSTRAINT;
        await rebalanceSagaService.recordCheckpoint(
          lockedSaga.id,
          SAGA_PHASE.QUOTE,
          lockedSaga.quoteKey!,
          { viable: false, reason: dry.reason },
        );
        await rebalanceSagaService.recordFailure(
          lockedSaga.id,
          failureClass,
          dry.reason ?? 'Dry-run failed',
        );
        const failedSaga = await rebalanceSagaService.getSagaByQueueEntry(entry.id);
        return {
          saga: failedSaga ?? lockedSaga,
          completed: false,
          resumedFromPhase: SAGA_PHASE.QUOTE,
          error: dry.reason,
        };
      }

      await rebalanceSagaService.recordCheckpoint(
        lockedSaga.id,
        SAGA_PHASE.QUOTE,
        lockedSaga.quoteKey!,
        { viable: true, estimatedFill: dry.estimatedFill },
      );
      await rebalanceSagaService.transitionState(lockedSaga.id, SAGA_STATE.SIMULATED);
      currentPhase = SAGA_PHASE.APPROVAL;
    }

    // APPROVAL phase — validate intent and approve execution
    if (currentPhase === SAGA_PHASE.APPROVAL) {
      if (options.simulateTimeoutAt === SAGA_PHASE.APPROVAL) {
        throw new Error('Simulated timeout during APPROVAL phase');
      }
      if (options.simulateFailureAt === SAGA_PHASE.APPROVAL) {
        throw new Error('Simulated failure during APPROVAL phase');
      }

      const strategy = entry.executionStrategy as Record<string, unknown>;
      if (strategy.intentValidUntil) {
        const expiry = new Date(strategy.intentValidUntil as string).getTime();
        if (Date.now() > expiry) {
          await rebalanceSagaService.recordFailure(
            lockedSaga.id,
            FAILURE_CLASS.STALE_INTENT,
            'Intent expired before approval',
          );
          throw new Error('Intent expired before approval');
        }
      }

      await rebalanceSagaService.recordCheckpoint(
        lockedSaga.id,
        SAGA_PHASE.APPROVAL,
        lockedSaga.approvalKey!,
        { approved: true, approvedAt: new Date().toISOString() },
      );
      currentPhase = SAGA_PHASE.SUBMIT;
    }

    // SUBMIT phase — build and submit transaction
    if (currentPhase === SAGA_PHASE.SUBMIT) {
      if (options.simulateTimeoutAt === SAGA_PHASE.SUBMIT) {
        throw new Error('Simulated timeout during SUBMIT phase');
      }
      if (options.simulateFailureAt === SAGA_PHASE.SUBMIT) {
        throw new Error('Simulated failure during SUBMIT phase');
      }
      if (options.simulateDuplicate) {
        throw new Error('Simulated duplicate submission detected');
      }

      const attempt: ExecutionAttempt = {
        entryId: entry.id,
        attemptNumber: (entry.attemptCount ?? 0) + 1,
        startedAt: new Date(),
        status: 'pending',
      };

      const result = await rebalanceExecutorService.execute(entry, attempt);
      transactionHash = result.transactionHash;
      feeBumpHash = (result.executionDetails as Record<string, unknown>).feeBumpHash as string | undefined;
      innerTxXdr = (result.executionDetails as Record<string, unknown>).innerTxXdr as string | undefined;

      await rebalanceSagaService.recordCheckpoint(
        lockedSaga.id,
        SAGA_PHASE.SUBMIT,
        lockedSaga.submissionKey!,
        { transactionHash, feeBumpHash },
      );
      await rebalanceSagaService.transitionState(lockedSaga.id, SAGA_STATE.SUBMITTED, {
        transactionHash,
        feeBumpHash,
        innerTxXdr,
      });
      currentPhase = SAGA_PHASE.CONFIRM;
    }

    // CONFIRM phase — poll for transaction confirmation
    if (currentPhase === SAGA_PHASE.CONFIRM) {
      if (options.simulateTimeoutAt === SAGA_PHASE.CONFIRM) {
        throw new Error('Simulated timeout during CONFIRM phase');
      }
      if (options.simulateFailureAt === SAGA_PHASE.CONFIRM) {
        throw new Error('Simulated failure during CONFIRM phase');
      }

      if (transactionHash || lockedSaga.transactionHash) {
        const hash = transactionHash ?? lockedSaga.transactionHash!;
        const confirmed = await rebalanceExecutorService.confirmTransaction(hash);

        if (!confirmed) {
          await rebalanceSagaService.recordFailure(
            lockedSaga.id,
            FAILURE_CLASS.TRANSIENT,
            'Transaction not confirmed within timeout.',
          );
          throw new Error('Transaction not confirmed within timeout');
        }

        await rebalanceSagaService.recordCheckpoint(
          lockedSaga.id,
          SAGA_PHASE.CONFIRM,
          lockedSaga.confirmationKey!,
          { confirmedAt: new Date().toISOString(), transactionHash: hash },
        );
        await rebalanceSagaService.transitionState(lockedSaga.id, SAGA_STATE.CONFIRMED, {
          transactionHash: hash,
        });
        currentPhase = SAGA_PHASE.SNAPSHOT;
      } else {
        await rebalanceSagaService.recordCheckpoint(
          lockedSaga.id,
          SAGA_PHASE.CONFIRM,
          lockedSaga.confirmationKey!,
          { confirmedAt: new Date().toISOString(), simulated: true },
        );
        await rebalanceSagaService.transitionState(lockedSaga.id, SAGA_STATE.CONFIRMED);
        currentPhase = SAGA_PHASE.SNAPSHOT;
      }
    }

    // SNAPSHOT phase — record post-execution portfolio snapshot
    if (currentPhase === SAGA_PHASE.SNAPSHOT) {
      if (options.simulateTimeoutAt === SAGA_PHASE.SNAPSHOT) {
        throw new Error('Simulated timeout during SNAPSHOT phase');
      }
      if (options.simulateFailureAt === SAGA_PHASE.SNAPSHOT) {
        throw new Error('Simulated failure during SNAPSHOT phase');
      }

      await rebalanceSagaService.recordCheckpoint(
        lockedSaga.id,
        SAGA_PHASE.SNAPSHOT,
        lockedSaga.snapshotKey!,
        {
          snapshotAt: new Date().toISOString(),
          targetAllocations: entry.targetAllocations,
          currentAllocations: entry.currentAllocations,
        },
      );
      currentPhase = SAGA_PHASE.COMPLETE;
    }

    // COMPLETE — mark saga as confirmed
    if (currentPhase === SAGA_PHASE.COMPLETE) {
      await rebalanceSagaService.transitionState(lockedSaga.id, SAGA_STATE.CONFIRMED, {
        transactionHash,
      });
    }

    const completedSaga = await rebalanceSagaService.getSagaByQueueEntry(entry.id);
    return {
      saga: completedSaga ?? lockedSaga,
      completed: true,
      resumedFromPhase: resumeFromPhase,
      transactionHash,
    };
  } catch (error) {
    const failureClass = classifySagaError(error);
    const message = error instanceof Error ? error.message : String(error);

    await rebalanceSagaService.recordRetry(
      lockedSaga.id,
      (lockedSaga.failureCount ?? 0) + 1,
      lockedSaga.currentPhase,
      message,
      failureClass,
      message,
    );

    const { shouldRetry, saga: failedSaga } = await rebalanceSagaService.recordFailure(
      lockedSaga.id,
      failureClass,
      message,
    );

    if (!shouldRetry) {
      if (failureClass === FAILURE_CLASS.CONSTRAINT || failureClass === FAILURE_CLASS.PERMANENT) {
        await rebalanceSagaService.requireManualReview(
          lockedSaga.id,
          `Unrecoverable failure: ${message}`,
        );
      }
    }

    return {
      saga: failedSaga,
      completed: false,
      resumedFromPhase: resumeFromPhase,
      error: message,
    };
  } finally {
    await rebalanceSagaService.releaseLock(lockedSaga.id, options.workerId);
  }
}

/**
 * Classify an error into a FailureClass for saga retry logic.
 */
export function classifySagaError(error: unknown): FailureClass {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (msg.includes('expired') || msg.includes('stale')) return FAILURE_CLASS.STALE_INTENT;
  if (msg.includes('constraint') || msg.includes('slippage') || msg.includes('dry-run')) {
    return FAILURE_CLASS.CONSTRAINT;
  }
  if (msg.includes('sequence') || msg.includes('fee')) return FAILURE_CLASS.FEE_SEQUENCE;
  if (msg.includes('malformed') || msg.includes('invalid xdr')) return FAILURE_CLASS.PERMANENT;
  if (msg.includes('duplicate')) return FAILURE_CLASS.PERMANENT;
  return FAILURE_CLASS.TRANSIENT;
}

/**
 * Recover stuck sagas (expired locks, interrupted executions).
 */
export async function recoverStuckSagas(workerId: string): Promise<{
  recovered: number;
  sagas: RebalanceSagaDTO[];
}> {
  const stuckSagas = await rebalanceSagaService.findStuckSagas();
  const recovered: RebalanceSagaDTO[] = [];

  for (const saga of stuckSagas) {
    const lockResult = await rebalanceSagaService.acquireLock(saga.id, workerId);
    if (lockResult.acquired && lockResult.saga) {
      await rebalanceSagaService.transitionState(saga.id, SAGA_STATE.PENDING);
      await rebalanceSagaService.releaseLock(saga.id, workerId);
      recovered.push(lockResult.saga);
    }
  }

  return { recovered: recovered.length, sagas: recovered };
}