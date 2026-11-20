import type { Redis } from "ioredis";
import { Queue } from "bullmq";
import type { ConfigureResult, ScheduleConfig, ScheduleMode } from "./types";
import { QUEUE_NAMES } from "../../queues/types";
import { ScheduleValidationService } from "./ScheduleValidationService";
import { resolveLocalTimeToUTC } from "../../utils/timezoneValidator";

const SCHEDULE_KEY = (walletAddress: string) =>
  `digest:schedule:${walletAddress}`;

const JOB_NAME = (walletAddress: string) => `digest-${walletAddress}`;

/** Repeat intervals in milliseconds */
const REPEAT_DAILY_MS = 86_400_000; // 24 hours
const REPEAT_WEEKLY_MS = 604_800_000; // 7 days
const REPEAT_THRESHOLD_MS = 300_000; // 5 minutes

export class DigestScheduler {
  private validationService = new ScheduleValidationService();

  constructor(
    private redis: Redis,
    private queue: Queue,
  ) {}

  /**
   * Persists a user's schedule configuration and registers the appropriate
   * BullMQ repeatable job, replacing any previously registered job.
   * Now with full timezone support.
   */
  async configure(
    walletAddress: string,
    config: Omit<ScheduleConfig, "walletAddress" | "updatedAt">,
  ): Promise<ConfigureResult> {
    // Validate event_threshold range
    if (
      config.mode === "event_threshold" &&
      (config.eventThreshold === undefined ||
        config.eventThreshold < 1 ||
        config.eventThreshold > 100)
    ) {
      return { ok: false, error: "INVALID_THRESHOLD" };
    }

    const updatedAt = new Date().toISOString();
    const scheduleConfig: ScheduleConfig = {
      walletAddress,
      ...config,
      updatedAt,
    };

    // Persist to Redis hash
    await this.redis.hset(
      SCHEDULE_KEY(walletAddress),
      "data",
      JSON.stringify(scheduleConfig),
    );

    // Remove any existing repeatable job for this user
    const jobName = JOB_NAME(walletAddress);
    const repeatableJobs = await this.queue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      if (job.name === jobName) {
        await this.queue.removeRepeatableByKey(job.key);
      }
    }

    // Register new repeatable job based on mode
    const jobData = {
      walletAddress,
      scheduleMode: config.mode as ScheduleMode,
    };

    if (config.mode === "daily") {
      // For daily: calculate next execution at the specified time in the user's timezone
      const nextExecution = this.calculateNextExecutionForDaily(
        config.timezone || "UTC",
        config.deliveryTime || "09:00",
      );

      await this.queue.add(jobName, jobData, {
        repeat: { every: REPEAT_DAILY_MS },
        jobId: jobName,
        delay: Math.max(0, nextExecution.getTime() - Date.now()),
      });
    } else if (config.mode === "weekly") {
      // For weekly: calculate next execution at the specified weekday/time in the user's timezone
      const hour = config.deliveryTime
        ? parseInt(config.deliveryTime.split(":")[0])
        : 9;
      const minute = config.deliveryTime
        ? parseInt(config.deliveryTime.split(":")[1])
        : 0;

      const nextExecution = this.validationService.calculateNextExecutionTime({
        timezone: config.timezone || "UTC",
        weekday: config.dayOfWeek || 0,
        hour,
        minute,
      });

      await this.queue.add(jobName, jobData, {
        repeat: { every: REPEAT_WEEKLY_MS },
        jobId: jobName,
        delay: Math.max(0, nextExecution.getTime() - Date.now()),
      });
    } else {
      // event_threshold: poll every 5 minutes on the threshold-check queue
      const thresholdQueue = new Queue(QUEUE_NAMES.DIGEST_THRESHOLD_CHECK, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        connection: this.redis as any,
      });
      await thresholdQueue.add(jobName, jobData, {
        repeat: { every: REPEAT_THRESHOLD_MS },
        jobId: jobName,
      });
    }

    return { ok: true };
  }

  /**
   * Retrieves the persisted ScheduleConfig for the given walletAddress,
   * or null if no configuration has been saved.
   */
  async getConfig(walletAddress: string): Promise<ScheduleConfig | null> {
    const raw = await this.redis.hget(SCHEDULE_KEY(walletAddress), "data");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ScheduleConfig;
    } catch {
      return null;
    }
  }

  /**
   * Calculate the next execution time for a daily schedule.
   */
  private calculateNextExecutionForDaily(
    timezone: string,
    deliveryTime: string,
  ): Date {
    const [hourStr, minuteStr] = deliveryTime.split(":");
    const hour = parseInt(hourStr, 10) || 0;
    const minute = parseInt(minuteStr, 10) || 0;

    // Get next execution for today at the specified time
    return resolveLocalTimeToUTC(timezone, hour, minute, new Date());
  }
}
