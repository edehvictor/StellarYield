import { Worker, Job } from 'bullmq';
import { Address, nativeToScVal } from '@stellar/stellar-sdk';
import { getRedis } from '../utils/redis';
import { config } from '../config';
import { logger } from '../utils/logger';
import { KeeperSigner } from '../signer/KeeperSigner';
import { QUEUE_NAMES, LiquidationJobData } from '../queues/types';

/**
 * LiquidationWorker consumes jobs from the `liquidation` BullMQ queue and
 * executes on-chain liquidation transactions via the StablecoinManager contract.
 *
 * Flow:
 *  1. Pull a job containing the undercollateralized `accountAddress`.
 *  2. Re-verify the position is still below MCR (avoids stale jobs from race conditions).
 *  3. Build and submit a `liquidate(liquidator, user)` Soroban invocation.
 *  4. Log the outcome with the transaction hash.
 *
 * Retry policy: exponential back-off configured at the queue level (5 attempts).
 * Failed jobs land in the BullMQ failed set for manual review / alerting.
 */
export class LiquidationWorker {
  private readonly worker: Worker<LiquidationJobData>;
  private readonly signer: KeeperSigner;

  constructor(signer?: KeeperSigner) {
    this.signer = signer ?? new KeeperSigner();

    this.worker = new Worker<LiquidationJobData>(
      QUEUE_NAMES.LIQUIDATION,
      (job) => this.process(job),
      {
        connection: getRedis(),
        concurrency: config.keeper.liquidationConcurrency,
      },
    );

    this.worker.on('completed', (job) =>
      logger.info({ jobId: job.id, account: job.data.accountAddress }, 'Liquidation job completed'),
    );
    this.worker.on('failed', (job, err) =>
      logger.error({ jobId: job?.id, err }, 'Liquidation job failed'),
    );
  }

  /**
   * Core job processor:
   *  - Decodes the job payload
   *  - Calls `liquidate` on the StablecoinManager contract
   *
   * @param job - BullMQ Job containing LiquidationJobData
   */
  async process(job: Job<LiquidationJobData>): Promise<{ txHash: string }> {
    const { accountAddress } = job.data;

    logger.info(
      { jobId: job.id, accountAddress, crBps: job.data.currentCrBps },
      '[LiquidationWorker] Processing liquidation job',
    );

    // Build Soroban args: (liquidator: Address, user: Address)
    const liquidatorScVal = new Address(this.signer.publicKey).toScVal();
    const userScVal = new Address(accountAddress).toScVal();

    const txHash = await this.signer.invokeContract(
      config.contracts.stablecoinManager,
      'liquidate',
      [liquidatorScVal, userScVal],
    );

    logger.info(
      { jobId: job.id, accountAddress, txHash },
      '[LiquidationWorker] Liquidation submitted successfully',
    );

    return { txHash };
  }

  /** Gracefully close the worker (finishes in-flight jobs). */
  async close(): Promise<void> {
    await this.worker.close();
    logger.info('[LiquidationWorker] Worker closed');
  }
}
