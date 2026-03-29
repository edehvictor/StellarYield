import 'dotenv/config';
import { logger } from './utils/logger';
import { getRedis, closeRedis } from './utils/redis';
import { createLiquidationQueue, createCompoundQueue, attachQueueEvents } from './queues';
import { VaultMonitor } from './monitors/VaultMonitor';
import { CompoundScheduler } from './monitors/CompoundScheduler';
import { LiquidationWorker } from './workers/LiquidationWorker';
import { CompoundWorker } from './workers/CompoundWorker';
import { KeeperSigner } from './signer/KeeperSigner';

/**
 * StellarYield Keeper Bot — main entry point.
 *
 * Startup sequence:
 *  1. Connect Redis.
 *  2. Initialise job queues (liquidation, compound).
 *  3. Attach queue event listeners for observability.
 *  4. Start BullMQ workers to process jobs.
 *  5. Start VaultMonitor scan loop → enqueues liquidation jobs.
 *  6. Register repeatable compound jobs via CompoundScheduler.
 *  7. Register graceful-shutdown handlers for SIGTERM / SIGINT.
 */
async function main(): Promise<void> {
  logger.info('🚀 StellarYield Keeper Bot starting...');

  // 1. Warm up Redis
  const redis = getRedis();
  await redis.connect();

  // 2. Create queues
  const liquidationQueue = createLiquidationQueue();
  const compoundQueue = createCompoundQueue();

  // 3. Attach observability listeners
  attachQueueEvents(liquidationQueue.name);
  attachQueueEvents(compoundQueue.name);

  // 4. Start workers
  const signer = new KeeperSigner();
  logger.info({ publicKey: signer.publicKey }, 'Keeper bot public key');

  const liquidationWorker = new LiquidationWorker(signer);
  const compoundWorker = new CompoundWorker(signer);

  // 5. Start vault monitor
  const vaultMonitor = new VaultMonitor(liquidationQueue);
  vaultMonitor.start();

  // 6. Schedule compound jobs
  const compoundScheduler = new CompoundScheduler(compoundQueue);
  await compoundScheduler.start();

  logger.info('✅ Keeper Bot fully operational');

  // 7. Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received — draining workers...');

    vaultMonitor.stop();
    await liquidationWorker.close();
    await compoundWorker.close();
    await liquidationQueue.close();
    await compoundQueue.close();
    await closeRedis();

    logger.info('Keeper Bot shutdown complete. Goodbye 👋');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during keeper bot startup');
  process.exit(1);
});
