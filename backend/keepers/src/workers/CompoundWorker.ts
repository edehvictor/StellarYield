import { Worker, Job } from 'bullmq';
import { Address, nativeToScVal } from '@stellar/stellar-sdk';
import { getRedis } from '../utils/redis';
import { config } from '../config';
import { logger } from '../utils/logger';
import { KeeperSigner } from '../signer/KeeperSigner';
import { QUEUE_NAMES, CompoundJobData } from '../queues/types';

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
    const { vaultContractId, minHarvestAmount } = job.data;

    logger.info(
      { jobId: job.id, vaultContractId },
      '[CompoundWorker] Processing compound job',
    );

    // harvest(caller: Address, min_amount: i128)
    const keeperScVal = new Address(this.signer.publicKey).toScVal();
    const minAmtXdr = nativeToScVal(BigInt(minHarvestAmount), { type: 'i128' });

    const txHash = await this.signer.invokeContract(
      vaultContractId,
      'harvest',
      [keeperScVal, minAmtXdr],
    );

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
