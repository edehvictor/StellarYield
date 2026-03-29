import { Queue, QueueEvents } from 'bullmq';
import { getRedis } from '../utils/redis';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  QUEUE_NAMES,
  LiquidationJobData,
  CompoundJobData,
} from './types';

const defaultJobOptions = {
  attempts: config.keeper.jobMaxAttempts,
  backoff: { type: 'exponential', delay: 5_000 } as const,
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

/**
 * BullMQ Queue for liquidation jobs.
 * Each job carries the account address and position snapshot that triggered it.
 */
export function createLiquidationQueue(): Queue<LiquidationJobData> {
  return new Queue<LiquidationJobData>(QUEUE_NAMES.LIQUIDATION, {
    connection: getRedis(),
    defaultJobOptions,
  });
}

/**
 * BullMQ Queue for auto-compound jobs.
 */
export function createCompoundQueue(): Queue<CompoundJobData> {
  return new Queue<CompoundJobData>(QUEUE_NAMES.COMPOUND, {
    connection: getRedis(),
    defaultJobOptions,
  });
}

/**
 * Attach event listeners that log queue lifecycle events for observability.
 * Call this once per queue after creation.
 */
export function attachQueueEvents(queueName: string): QueueEvents {
  const events = new QueueEvents(queueName, { connection: getRedis() });

  events.on('completed', ({ jobId }) =>
    logger.info({ queueName, jobId }, 'Job completed'),
  );
  events.on('failed', ({ jobId, failedReason }) =>
    logger.error({ queueName, jobId, failedReason }, 'Job failed'),
  );
  events.on('stalled', ({ jobId }) =>
    logger.warn({ queueName, jobId }, 'Job stalled'),
  );

  return events;
}
