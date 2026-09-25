import { Queue } from 'bullmq';
import { getRedisConnectionStatus } from './index';
import { QUEUE_NAMES } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw job-state counts for a single queue.
 *
 * `pending`   — jobs waiting in the queue (BullMQ "waiting" state).
 * `delayed`   — jobs deferred until a future timestamp.
 * `active`    — jobs currently being processed by a worker.
 * `completed` — jobs that finished successfully.
 * `failed`    — jobs that threw an error on their last attempt (but may still
 *               be retried if `attempts` budget remains).
 * `poison`    — jobs that have permanently exhausted all retry attempts and
 *               will never be processed again without manual intervention.
 */
export interface QueueJobCounts {
  pending: number;
  delayed: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  /** #907: Count of jobs quarantined to the poison queue */
  poison: number;
}

export interface QueueHealthEntry {
  name: string;
  counts: QueueJobCounts;
  status: 'healthy' | 'degraded' | 'outage';
  warnings: string[];
}

export interface QueueHealthSummary {
  /** One entry per queue passed to `getQueueHealth`. */
  queues: QueueHealthEntry[];
  overallStatus: 'healthy' | 'degraded' | 'outage';
  timestamp: string;
  /** #909: Redis connection state derived from latency and errors */
  redisStatus: 'healthy' | 'degraded' | 'outage';
}

// ---------------------------------------------------------------------------
// Thresholds (overridable via environment variables)
// ---------------------------------------------------------------------------

export const QUEUE_HEALTH_THRESHOLDS = {
  /** Maximum number of failed jobs before a `warning` is emitted. */
  failed: Number(process.env.QUEUE_FAILED_THRESHOLD ?? '10'),
  /** Maximum number of delayed jobs before a `warning` is emitted. */
  delayed: Number(process.env.QUEUE_DELAYED_THRESHOLD ?? '50'),
  /** #907: Retry budget exhaustion warning threshold */
  poison: Number(process.env.QUEUE_POISON_THRESHOLD ?? '5'),
} as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count how many jobs in the failed set have permanently exhausted all
 * configured retry attempts — these are "poison" jobs.
 *
 * BullMQ does not have a first-class "poison" queue state; we derive it by
 * inspecting `job.attemptsMade` against `job.opts.attempts`.
 *
 * We inspect at most `maxScan` failed jobs to bound the cost of this check.
 */
async function getPoisonCount(queue: Queue, maxScan = 500): Promise<number> {
  try {
    const failed = await queue.getFailed(0, maxScan - 1);
    return failed.filter((job) => {
      const attempts = job.opts?.attempts ?? 1;
      return job.attemptsMade >= attempts;
    }).length;
  } catch {
    // If getFailed is unavailable (e.g. in tests with minimal mocks), default to 0.
    return 0;
  }
}

/**
 * Retrieve the oldest pending job's age in milliseconds by inspecting the
 * first job in the waiting list.  Returns `null` when there are no pending
 * jobs or when the timestamp cannot be determined.
 */
async function getOldestPendingAgeMs(queue: Queue, nowMs: number): Promise<number | null> {
  try {
    const waiting = await queue.getWaiting(0, 0); // first job only
    if (waiting.length === 0) return null;
    const job = waiting[0];
    const ts = job.timestamp; // BullMQ sets this at enqueue time (unix ms)
    if (typeof ts !== 'number' || ts <= 0) return null;
    return Math.max(0, nowMs - ts);
  } catch {
    return null;
  }
}

/**
 * Retrieve the `failedReason` from the most recently failed job.
 * BullMQ stores failed jobs in reverse-chronological order, so the first
 * result is the most recent failure.
 */
async function getLatestFailureReason(queue: Queue): Promise<string | null> {
  try {
    const failed = await queue.getFailed(0, 0); // most recent failure only
    if (failed.length === 0) return null;
    return (failed[0].failedReason as string | undefined) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core export
// ---------------------------------------------------------------------------

/**
 * Collect counts, quality metrics, and threshold-based warnings for every
 * queue in the supplied list, then return an aggregated summary.
 *
 * Also builds a `workers` map that mirrors the same data keyed by the
 * convention `"<queueName>Worker"` so callers can address metrics for the
 * compound and liquidation workers explicitly.
 */
export async function getQueueHealth(queues: Queue[]): Promise<QueueHealthSummary> {
  const redisStatus = await getRedisConnectionStatus();

  const entries = await Promise.all(
    queues.map(async (queue): Promise<QueueHealthEntry> => {
      // ── Job counts ────────────────────────────────────────────────────────
      const raw = await queue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );

      const poisonCount = await getPoisonCount(queue);

      const counts: QueueJobCounts = {
        pending: raw.waiting ?? 0,
        delayed: raw.delayed ?? 0,
        active: raw.active ?? 0,
        completed: raw.completed ?? 0,
        failed: raw.failed ?? 0,
        poison: poisonCount,
      };

      // ── Quality metrics ───────────────────────────────────────────────────
      const [oldestPendingAgeMs, latestFailureReason] = await Promise.all([
        counts.pending > 0 ? getOldestPendingAgeMs(queue, nowMs) : Promise.resolve(null),
        counts.failed > 0 ? getLatestFailureReason(queue) : Promise.resolve(null),
      ]);

      const metrics: QueueQualityMetrics = {
        oldestPendingAgeMs,
        latestFailureReason,
      };

      // ── Threshold warnings ────────────────────────────────────────────────
      const warnings: string[] = [];

      if (counts.failed > t.failed) {
        warnings.push(
          `failed jobs (${counts.failed}) exceed threshold (${t.failed})`,
        );
      }
      if (counts.delayed > t.delayed) {
        warnings.push(
          `delayed jobs (${counts.delayed}) exceed threshold (${t.delayed})`,
        );
      }
      if (counts.pending > t.pending) {
        warnings.push(
          `pending jobs (${counts.pending}) exceed threshold (${t.pending})`,
        );
      }
      if (counts.poison > t.poison) {
        warnings.push(
          `poison jobs (${counts.poison}) exceed threshold (${t.poison}) — manual intervention required`,
        );
      }
      if (
        oldestPendingAgeMs !== null &&
        oldestPendingAgeMs > t.oldestPendingAgeMs
      ) {
        warnings.push(
          `oldest pending job is ${Math.round(oldestPendingAgeMs / 1000)}s old (threshold ${Math.round(t.oldestPendingAgeMs / 1000)}s)`,
        );
      }
      if (counts.poison > QUEUE_HEALTH_THRESHOLDS.poison) {
        warnings.push(
          `poison jobs (${counts.poison}) exceed threshold (${QUEUE_HEALTH_THRESHOLDS.poison})`,
        );
      }

      // #909: Degrade queue status if Redis is not healthy
      let status: QueueHealthEntry['status'] = 'healthy';
      if (redisStatus === 'outage') {
        status = 'outage';
      } else if (redisStatus === 'degraded' || warnings.length > 0) {
        status = 'degraded';
      }

      return {
        name: queue.name,
        counts,
        status,
        metrics,
        status: warnings.length > 0 ? 'warning' : 'healthy',
        warnings,
      };
    }),
  );

  const overallStatus = redisStatus === 'outage'
    ? 'outage'
    : entries.some((e) => e.status === 'outage')
      ? 'outage'
      : entries.some((e) => e.status === 'degraded')
        ? 'degraded'
        : 'healthy';

  return {
    queues: entries,
    overallStatus,
  // ── Per-worker map ─────────────────────────────────────────────────────────
  // Convention: "liquidation" → "liquidationWorker", "compound" → "compoundWorker"
  const workers: Record<string, QueueHealthEntry> = {};
  for (const entry of entries) {
    const workerKey = `${entry.name}Worker`;
    workers[workerKey] = entry;
  }

  return {
    queues: entries,
    workers,
    overallStatus: entries.some((e) => e.status === 'warning') ? 'warning' : 'healthy',
    timestamp: new Date().toISOString(),
    redisStatus,
  };
}