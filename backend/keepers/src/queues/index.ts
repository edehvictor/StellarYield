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

// ── Compound idempotency (#1533) ──────────────────────────────────────────────

/**
 * Length of one compound schedule window. Matches the CompoundScheduler cron
 * pattern (every 4 hours) so each window maps to exactly one compound action
 * per vault.
 */
export const COMPOUND_PERIOD_MS = 4 * 60 * 60 * 1000;

/**
 * #1533: Build the stable vault + period key for a compound window.
 * Deterministic for every instant inside the same 4h window, so a worker that
 * restarts (or a job that is retried) inside the window computes the same key
 * and can detect an already-broadcast compound.
 */
export function compoundPeriodKey(
  vaultContractId: string,
  atMs: number = Date.now(),
): string {
  const windowStart = Math.floor(atMs / COMPOUND_PERIOD_MS) * COMPOUND_PERIOD_MS;
  return `compound:${vaultContractId}:${windowStart}`;
}

/** Record of a broadcast compound keyed by vault + period (#1533). */
export interface CompoundBroadcastRecord {
  vaultContractId: string;
  periodKey: string;
  txHash: string;
  jobId?: string;
  recordedAt: string;
}

const COMPOUND_BROADCAST_PREFIX = 'keeper:compound:broadcast:';
/** TTL covers ≥6 schedule windows so late retries still hit the record. */
const COMPOUND_BROADCAST_TTL_SECONDS = 24 * 60 * 60;

/**
 * #1533: Look up the broadcast record for a vault + period window.
 * Returns null when no broadcast was recorded for the window (or Redis is
 * unavailable — treated as "no record" so behaviour degrades to at-least-once
 * rather than blocking compounding).
 */
export async function getCompoundBroadcastRecord(
  periodKey: string,
): Promise<CompoundBroadcastRecord | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(`${COMPOUND_BROADCAST_PREFIX}${periodKey}`);
    if (!raw) return null;
    return JSON.parse(raw) as CompoundBroadcastRecord;
  } catch {
    return null;
  }
}

/**
 * #1533: Persist the broadcast record for a vault + period window.
 * Written immediately after a successful broadcast, before any other
 * bookkeeping, so a crash right after submission is still recoverable.
 */
export async function recordCompoundBroadcast(
  record: CompoundBroadcastRecord,
): Promise<void> {
  try {
    const redis = getRedis();
    await redis.setex(
      `${COMPOUND_BROADCAST_PREFIX}${record.periodKey}`,
      COMPOUND_BROADCAST_TTL_SECONDS,
      JSON.stringify(record),
    );
  } catch (err) {
    logger.warn(
      { err, periodKey: record.periodKey },
      'Failed to persist compound broadcast record',
    );
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

// ── Dead-letter queue (#1537) ──────────────────────────────────────────────

const DEAD_LETTER_PREFIX = 'keeper:dead-letter:';

export interface DeadLetterEntry {
  id: string;
  queueName: string;
  jobData: Record<string, unknown>;
  failureReason: string;
  failedAttempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Move a permanently failed job to the dead-letter queue with full failure
 * context for operator inspection and manual replay (#1537).
 */
export async function moveToDeadLetter(
  queueName: string,
  jobId: string,
  jobData: Record<string, unknown>,
  failureReason: string,
  failedAttempts: number,
  error?: string,
): Promise<void> {
  try {
    const redis = getRedis();
    const entry: DeadLetterEntry = {
      id: jobId,
      queueName,
      jobData,
      failureReason,
      failedAttempts,
      firstFailedAt: new Date().toISOString(),
      lastFailedAt: new Date().toISOString(),
      error,
    };
    const key = `${DEAD_LETTER_PREFIX}${queueName}:${jobId}`;
    await redis.setex(key, 30 * 24 * 60 * 60, JSON.stringify(entry)); // 30-day TTL
    // Also add to a sorted set for listing
    await redis.zadd(`${DEAD_LETTER_PREFIX}index`, Date.now(), key);
    logger.warn({ queueName, jobId, failureReason }, 'Job moved to dead-letter queue');
  } catch (err) {
    logger.error({ err, queueName, jobId }, 'Failed to move job to dead-letter queue');
  }
}

/**
 * List dead-letter entries, optionally filtered by queue name (#1537).
 */
export async function listDeadLetter(
  queueName?: string,
  limit = 50,
): Promise<DeadLetterEntry[]> {
  try {
    const redis = getRedis();
    const pattern = queueName
      ? `${DEAD_LETTER_PREFIX}${queueName}:*`
      : `${DEAD_LETTER_PREFIX}*`;
    const keys = await redis.keys(pattern);
    const entries: DeadLetterEntry[] = [];
    for (const key of keys.slice(0, limit)) {
      const raw = await redis.get(key);
      if (raw) entries.push(JSON.parse(raw) as DeadLetterEntry);
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Inspect a single dead-letter entry (#1537).
 */
export async function inspectDeadLetter(
  queueName: string,
  jobId: string,
): Promise<DeadLetterEntry | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(`${DEAD_LETTER_PREFIX}${queueName}:${jobId}`);
    return raw ? (JSON.parse(raw) as DeadLetterEntry) : null;
  } catch {
    return null;
  }
}

/**
 * Manually replay a dead-letter entry back into its original queue (#1537).
 * Removes the entry from the dead-letter store after successful re-enqueue.
 */
export async function replayDeadLetter(
  queueName: string,
  jobId: string,
): Promise<boolean> {
  try {
    const entry = await inspectDeadLetter(queueName, jobId);
    if (!entry) return false;

    const queue = new Queue(queueName, { connection: getRedis() });
    await queue.add(`replay:${jobId}`, entry.jobData, {
      attempts: config.keeper.jobMaxAttempts,
      backoff: { type: 'exponential', delay: 5_000 },
    });

    const redis = getRedis();
    await redis.del(`${DEAD_LETTER_PREFIX}${queueName}:${jobId}`);
    await redis.zrem(`${DEAD_LETTER_PREFIX}index`, `${DEAD_LETTER_PREFIX}${queueName}:${jobId}`);

    logger.info({ queueName, jobId }, 'Dead-letter job replayed');
    return true;
  } catch (err) {
    logger.error({ err, queueName, jobId }, 'Failed to replay dead-letter job');
    return false;
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
 * #1533: Uses the stable vault + period key as the BullMQ job ID so that
 * duplicate enqueues within the same 4h window are collapsed by the queue
 * itself, even across producer restarts.
 */
export async function enqueueCompoundJob(
  vaultContractId: string,
  minHarvestAmount: string,
  requiredSequence: number,
): Promise<string> {
  const queue = createCompoundQueue();
  const fencingToken = nextFencingToken(QUEUE_NAMES.COMPOUND, vaultContractId);
  const periodKey = compoundPeriodKey(vaultContractId);

  const job = await queue.add(
    `compound:${vaultContractId}`,
    {
      vaultContractId,
      minHarvestAmount,
      fencingToken,
      requiredSequence,
      periodKey,
    } as CompoundJobData,
    { jobId: periodKey },
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
    { jobId: job.id, vaultContractId, periodKey, fencingToken, requiredSequence },
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
