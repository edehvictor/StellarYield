import { Queue, QueueEvents, Job } from 'bullmq';
import { getRedis } from '../utils/redis';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  QUEUE_NAMES,
  LiquidationJobData,
  CompoundJobData,
  JOB_STATES,
  TERMINAL_FAILURE_REASONS,
  isRetryableError,
  type JobAttemptRecord,
  type QueueName,
} from './types';

export { isRetryableError, TERMINAL_FAILURE_REASONS, JOB_STATES, QUEUE_NAMES };
export type { JobAttemptRecord, QueueName, LiquidationJobData, CompoundJobData };

export { getQueueHealth } from './health';
export type { QueueHealthSummary, QueueHealthEntry, QueueJobCounts, QueueQualityMetrics } from './health';

const defaultJobOptions = {
  attempts: config.keeper.jobMaxAttempts,
  backoff: { type: 'exponential', delay: 5_000 } as const,
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

/**
 * #907: Extended job options with retry budget control.
 */
export interface KeeperJobOptions {
  attempts?: number;
  backoff?: { type: 'exponential'; delay: number };
  removeOnComplete?: { count: number };
  removeOnFail?: { count: number };
}

/**
 * #906: In-memory fence tracker for exactly-once execution.
 * Maps (queueName, targetId) -> current fencing token expected by callers.
 */
const fenceStore = new Map<string, number>();

/**
 * #906: Atomically increment and return the next fencing token for a target.
 * Callers must use this value when creating jobs; workers reject jobs whose
 * token does not match the current store value.
 */
export function nextFencingToken(queueName: string, targetId: string): number {
  const key = `${queueName}:${targetId}`;
  const current = fenceStore.get(key) ?? 0;
  const next = current + 1;
  fenceStore.set(key, next);
  logger.debug({ queueName, targetId, token: next }, 'Advanced fencing token');
  return next;
}

/**
 * #906: Validate that the job's fencing token matches the current store value.
 * Returns true if the token is fresh; false if the job is stale.
 */
export function validateFencingToken(queueName: string, targetId: string, token: number): boolean {
  const key = `${queueName}:${targetId}`;
  const current = fenceStore.get(key) ?? 0;
  if (token !== current) {
    logger.warn(
      { queueName, targetId, expected: current, actual: token },
      'Fencing token mismatch — rejecting stale job',
    );
    return false;
  }
  return true;
}

/**
 * #906: Persist a job attempt record for crash recovery and observability.
 * Stored in a predictable Redis key so duplicate workers can detect claimed work.
 */
const JOB_RECORD_PREFIX = 'keeper:job:attempt:';
const JOB_RECORD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function persistJobRecord(record: JobAttemptRecord): Promise<void> {
  try {
    const redis = getRedis();
    const key = `${JOB_RECORD_PREFIX}${record.queueName}:${record.jobId}`;
    await redis.setex(
      key,
      Math.floor(JOB_RECORD_TTL_MS / 1000),
      JSON.stringify(record),
    );
  } catch (err) {
    logger.warn({ err, jobId: record.jobId }, 'Failed to persist job attempt record');
  }
}

/**
 * #906: Fetch a persisted job attempt record.
 */
export async function getJobRecord(
  queueName: QueueName,
  jobId: string,
): Promise<JobAttemptRecord | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(`${JOB_RECORD_PREFIX}${queueName}:${jobId}`);
    if (!raw) return null;
    return JSON.parse(raw) as JobAttemptRecord;
  } catch {
    return null;
  }
}

/**
 * #907: Classify a job failure and return the terminal reason if non-retryable.
 */
export function classifyFailure(error: unknown): {
  reason: string;
  retryable: boolean;
} {
  if (!error) {
    return { reason: TERMINAL_FAILURE_REASONS.NON_RETRYABLE_ERROR, retryable: false };
  }

  const message = error instanceof Error ? error.message : String(error);
  const retryable = isRetryableError(message);

  if (!retryable) {
    let reason: string = TERMINAL_FAILURE_REASONS.NON_RETRYABLE_ERROR;
    if (message.includes('SEQUENCE_MISMATCH') || message.includes('sequence')) {
      reason = TERMINAL_FAILURE_REASONS.SEQUENCE_MISMATCH;
    } else if (message.includes('FENCING_VIOLATION')) {
      reason = TERMINAL_FAILURE_REASONS.FENCING_VIOLATION;
    } else if (message.includes('QUOTA_EXCEEDED')) {
      reason = TERMINAL_FAILURE_REASONS.QUOTA_EXCEEDED;
    }
    return { reason, retryable: false };
  }

  return { reason: 'RETRYABLE_ERROR', retryable: true };
}

/**
 * #907: Move an exhausted job to the poison queue for operator review.
 */
export async function quarantineJob(
  sourceQueue: Queue,
  job: Job,
  reason: string,
  targetId: string,
): Promise<void> {
  try {
    const poisonQueue = new Queue(QUEUE_NAMES.POISON, { connection: getRedis() });

    // Preserve original payload plus failure metadata
    await poisonQueue.add(
      `poison:${job.id}`,
      {
        ...job.data,
        _poisonReason: reason,
        _originalJobId: job.id,
        _quarantinedAt: new Date().toISOString(),
        _targetId: targetId,
        _failedAttempts: job.attemptsMade,
      },
      {
        attempts: 0, // No retries in poison
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 1000 },
      },
    );

    logger.warn(
      { jobId: job.id, queueName: sourceQueue.name, reason, targetId },
      'Job moved to poison queue',
    );
  } catch (err) {
    logger.error(
      { err, jobId: job.id, queueName: sourceQueue.name },
      'Failed to quarantine job',
    );
  }
}

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
 * #906: Enqueue a liquidation job with sequence and fence metadata.
 */
export async function enqueueLiquidationJob(
  accountAddress: string,
  currentCrBps: number,
  collateralValueUsd: string,
  debtAmount: string,
  requiredSequence: number,
): Promise<string> {
  const queue = createLiquidationQueue();
  const fencingToken = nextFencingToken(QUEUE_NAMES.LIQUIDATION, accountAddress);

  const job = await queue.add(
    `liquidation:${accountAddress}`,
    {
      accountAddress,
      currentCrBps,
      collateralValueUsd,
      debtAmount,
      fencingToken,
      requiredSequence,
    } as LiquidationJobData,
    { jobId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  );

  await persistJobRecord({
    jobId: job.id!,
    queueName: QUEUE_NAMES.LIQUIDATION,
    state: JOB_STATES.CREATED,
    attemptNumber: 0,
    fencingToken,
    requiredSequence,
    claimedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    targetId: accountAddress,
  });

  logger.info(
    { jobId: job.id, accountAddress, fencingToken, requiredSequence },
    'Liquidation job enqueued',
  );

  return job.id!;
}

/**
 * #906: Enqueue a compound job with sequence and fence metadata.
 */
export async function enqueueCompoundJob(
  vaultContractId: string,
  minHarvestAmount: string,
  requiredSequence: number,
): Promise<string> {
  const queue = createCompoundQueue();
  const fencingToken = nextFencingToken(QUEUE_NAMES.COMPOUND, vaultContractId);

  const job = await queue.add(
    `compound:${vaultContractId}`,
    {
      vaultContractId,
      minHarvestAmount,
      fencingToken,
      requiredSequence,
    } as CompoundJobData,
    { jobId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  );

  await persistJobRecord({
    jobId: job.id!,
    queueName: QUEUE_NAMES.COMPOUND,
    state: JOB_STATES.CREATED,
    attemptNumber: 0,
    fencingToken,
    requiredSequence,
    claimedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    targetId: vaultContractId,
  });

  logger.info(
    { jobId: job.id, vaultContractId, fencingToken, requiredSequence },
    'Compound job enqueued',
  );

  return job.id!;
}

/**
 * #909: Get degraded Redis connection status for health checks.
 * Distinguishes between degraded (slow/flaky) and total outage.
 */
export async function getRedisConnectionStatus(): Promise<
  'healthy' | 'degraded' | 'outage'
> {
  try {
    const redis = getRedis();
    const start = Date.now();
    await redis.ping();
    const latencyMs = Date.now() - start;

    if (latencyMs > 1000) {
      logger.warn({ latencyMs }, 'Redis degraded — high latency');
      return 'degraded';
    }

    return 'healthy';
  } catch (err) {
    logger.error({ err }, 'Redis connection outage');
    return 'outage';
  }
}

/**
 * Attach event listeners that log queue lifecycle events for observability.
 * Call this once per queue after creation.
 */
export function attachQueueEvents(queueName: string): QueueEvents {
  const events = new QueueEvents(queueName, { connection: getRedis() });

  events.on('completed', (args: { jobId: string }) =>
    logger.info({ queueName, jobId: args.jobId }, 'Job completed'),
  );
  events.on('failed', (args: { jobId: string; failedReason: string }) =>
    logger.error({ queueName, jobId: args.jobId, failedReason: args.failedReason }, 'Job failed'),
  );
  events.on('stalled', (args: { jobId: string }) =>
    logger.warn({ queueName, jobId: args.jobId }, 'Job stalled'),
  );

  return events;
}
