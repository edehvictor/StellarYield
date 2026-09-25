import type { Redis } from 'ioredis';
import { Worker, Queue } from 'bullmq';
import type { Job, WorkerOptions } from 'bullmq';
import { DigestBuilder } from '../services/digest/DigestBuilder';
import type { DigestDeliveryService } from '../services/digest/DigestDeliveryService';
import type { ScheduleConfig, ScheduleMode } from '../services/digest/types';
import { QUEUE_NAMES } from '../queues/types';

// ─── Job data shapes ──────────────────────────────────────────────────────────

export interface DigestGenerationJobData {
  walletAddress: string;
  scheduleMode: ScheduleMode;
  triggeredAt: string; // ISO 8601
}

export interface DigestThresholdCheckJobData {
  walletAddress: string;
  scheduleMode: 'event_threshold';
}

// ─── Redis key helpers ────────────────────────────────────────────────────────

const AUDIT_KEY = (walletAddress: string) =>
  `digest:audit:${walletAddress}`;

const EVENTS_KEY = (walletAddress: string) =>
  `digest:events:${walletAddress}`;

const SCHEDULE_KEY = (walletAddress: string) =>
  `digest:schedule:${walletAddress}`;

// ─── DigestGenerationWorker ───────────────────────────────────────────────────

/**
 * Processes jobs from the `digest-generation` queue.
 *
 * For each job:
 *  1. Calls DigestBuilder.buildDigest to run the full pipeline.
 *  2. If the resulting payload has no clusters, skips delivery (logs and returns).
 *  3. Otherwise calls DigestDeliveryService.deliver with the payload.
 *  4. Appends an ISO 8601 timestamp to the Redis audit list for the wallet.
 *
 * Requirements: 5.6, 5.7
 */
export function createDigestGenerationWorker(
  redis: Redis,
  digestBuilder: DigestBuilder,
  deliveryService: DigestDeliveryService,
): Worker<DigestGenerationJobData> {
  return new Worker<DigestGenerationJobData>(
    QUEUE_NAMES.DIGEST_GENERATION,
    async (job: Job<DigestGenerationJobData>) => {
      const { walletAddress, scheduleMode } = job.data;

      const payload = await digestBuilder.buildDigest(walletAddress, scheduleMode);

      if (payload.clusters.length === 0) {
        console.info(
          `[digest-generation] No pending events for ${walletAddress} — skipping delivery.`,
        );
        return;
      }

      await deliveryService.deliver(payload);

      // Append audit timestamp — Requirement 5.7
      await redis.rpush(AUDIT_KEY(walletAddress), new Date().toISOString());
    },
    { connection: redis } as WorkerOptions,
  );
}

// ─── DigestThresholdCheckWorker ───────────────────────────────────────────────

/**
 * Processes jobs from the `digest-threshold-check` queue.
 *
 * For each job:
 *  1. Counts pending events via ZCARD on the events sorted set.
 *  2. Fetches the user's ScheduleConfig from Redis.
 *  3. If event count >= eventThreshold, enqueues a digest-generation job.
 *
 * Requirements: 5.4
 */
export function createDigestThresholdCheckWorker(
  redis: Redis,
  digestBuilder: DigestBuilder,
  generationQueue: Queue,
): Worker<DigestThresholdCheckJobData> {
  return new Worker<DigestThresholdCheckJobData>(
    QUEUE_NAMES.DIGEST_THRESHOLD_CHECK,
    async (job: Job<DigestThresholdCheckJobData>) => {
      const { walletAddress } = job.data;

      // Count pending events — Requirement 5.4
      const eventCount = await redis.zcard(EVENTS_KEY(walletAddress));

      // Fetch schedule config
      const raw = await redis.hget(SCHEDULE_KEY(walletAddress), 'data');
      if (!raw) {
        console.warn(
          `[digest-threshold-check] No schedule config found for ${walletAddress} — skipping.`,
        );
        return;
      }

      let config: ScheduleConfig;
      try {
        config = JSON.parse(raw) as ScheduleConfig;
      } catch {
        console.warn(
          `[digest-threshold-check] Failed to parse schedule config for ${walletAddress} — skipping.`,
        );
        return;
      }

      const threshold = config.eventThreshold;
      if (threshold === undefined) {
        console.warn(
          `[digest-threshold-check] No eventThreshold set for ${walletAddress} — skipping.`,
        );
        return;
      }

      if (eventCount >= threshold) {
        const triggeredAt = new Date().toISOString();
        await generationQueue.add(
          `digest-${walletAddress}`,
          {
            walletAddress,
            scheduleMode: 'event_threshold' as ScheduleMode,
            triggeredAt,
          } satisfies DigestGenerationJobData,
        );
        console.info(
          `[digest-threshold-check] Threshold reached for ${walletAddress} ` +
            `(${eventCount} >= ${threshold}) — enqueued digest-generation job.`,
        );
      }
    },
    { connection: redis } as WorkerOptions,
  );
}
