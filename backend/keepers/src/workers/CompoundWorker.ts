import { Worker, Job } from 'bullmq';
import { Address, nativeToScVal } from '@stellar/stellar-sdk';
import { getRedis } from '../utils/redis';
import { config } from '../config';
import { logger } from '../utils/logger';
import { KeeperSigner } from '../signer/KeeperSigner';
import { QUEUE_NAMES, CompoundJobData, JOB_STATES } from '../queues/types';
import {
  validateFencingToken,
  getJobRecord,
  persistJobRecord,
  classifyFailure,
  quarantineJob,
  createCompoundQueue,
} from '../queues';

/**
 * CompoundWorker processes auto-compound jobs.
 * It calls the YieldVault's `harvest` function which:
 *   1. Collects accrued protocol rewards.
 *   2. Swaps them back to the vault's deposit token.
 *   3. Re-deposits, increasing the vault's `total_assets` (and thus share price).
 *
 * This makes the vault self-compounding without user intervention.
 *
 * Jobs are produced by the CompoundScheduler on a time-based schedule and
 * can also be triggered manually via the admin API.
 *
 * #906 Exactly-once guarantees:
 *  - Workers validate the fencing token before execution.
 *  - Job attempt records are persisted to Redis for crash recovery.
 *  - Required Stellar sequence is verified before submission.
 *
 * #907 Poison isolation:
 *  - Non-retryable failures are classified and moved to the poison queue.
 *  - Retryable failures are re-queued by BullMQ with exponential backoff.
 */
export class CompoundWorker {
  private readonly worker: Worker<CompoundJobData>;
  private readonly signer: KeeperSigner;

  constructor(signer?: KeeperSigner) {
    this.signer = signer ?? new KeeperSigner();

    this.worker = new Worker<CompoundJobData>(
      QUEUE_NAMES.COMPOUND,
      (job) => this.process(job),
      {
        connection: getRedis(),
        concurrency: config.keeper.compoundConcurrency,
      },
    );

    this.worker.on('completed', (job) =>
      logger.info({ jobId: job.id, vault: job.data.vaultContractId }, 'Compound job completed'),
    );
    this.worker.on('failed', (job, err) =>
      logger.error({ jobId: job?.id, err }, 'Compound job failed'),
    );
  }

  /**
   * Process a compound job by calling `harvest` on the target YieldVault.
   *
   * @param job - BullMQ Job containing CompoundJobData
   */
  async process(job: Job<CompoundJobData>): Promise<{ txHash: string }> {
    const { vaultContractId, minHarvestAmount, fencingToken, requiredSequence } = job.data;

    logger.info(
      { jobId: job.id, vaultContractId, fencingToken, requiredSequence },
      '[CompoundWorker] Processing compound job',
    );

    // #906: Reject stale jobs whose fencing token no longer matches
    if (!validateFencingToken(QUEUE_NAMES.COMPOUND, vaultContractId, fencingToken)) {
      throw new Error(`FENCING_VIOLATION: stale fencing token for vault ${vaultContractId}`);
    }

    // Mark claimed and persist attempt record
    try {
      await persistJobRecord({
        jobId: job.id!,
        queueName: QUEUE_NAMES.COMPOUND,
        state: JOB_STATES.CLAIMED,
        attemptNumber: job.attemptsMade,
        fencingToken,
        requiredSequence,
        claimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        targetId: vaultContractId,
      });
    } catch (err) {
      logger.warn({ err, jobId: job.id }, 'Failed to persist claim record');
    }

    // #906: Fetch current Stellar sequence and verify it matches the job requirement
    try {
      const account = await this.signer['server'].getAccount(this.signer.publicKey);
      const currentSequence = parseInt((account as any).sequence, 10);
      if (currentSequence !== requiredSequence) {
        throw new Error(
          `SEQUENCE_MISMATCH: expected sequence ${requiredSequence}, got ${currentSequence}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const { retryable } = classifyFailure(err);
      if (!retryable) {
        await quarantineJob(createCompoundQueue(), job, message, vaultContractId);
      }
      throw err;
    }

    // harvest(caller: Address, min_amount: i128)
    const keeperScVal = new Address(this.signer.publicKey).toScVal();
    const minAmtXdr = nativeToScVal(BigInt(minHarvestAmount), { type: 'i128' });

    let txHash: string;
    try {
      txHash = await this.signer.invokeContract(
        vaultContractId,
        'harvest',
        [keeperScVal, minAmtXdr],
        undefined,
        { workerName: 'CompoundWorker', jobId: job.id, policyVersion: 'v1' },
      );

      // Persist submitted state
      await persistJobRecord({
        jobId: job.id!,
        queueName: QUEUE_NAMES.COMPOUND,
        state: JOB_STATES.SUBMITTED,
        attemptNumber: job.attemptsMade,
        fencingToken,
        requiredSequence,
        txHash,
        claimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        targetId: vaultContractId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const { retryable, reason } = classifyFailure(err);
      if (!retryable) {
        await quarantineJob(createCompoundQueue(), job, reason, vaultContractId);
      }
      throw err;
    }

    logger.info(
      { jobId: job.id, vaultContractId, txHash },
      '[CompoundWorker] Compound submitted successfully',
    );

    return { txHash };
  }

  /** Gracefully close the worker (drains in-flight jobs). */
  async close(): Promise<void> {
    await this.worker.close();
    logger.info('[CompoundWorker] Worker closed');
  }
}