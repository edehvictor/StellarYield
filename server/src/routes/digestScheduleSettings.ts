/**
 * Routes for validating and saving weekly digest schedule settings.
 * Handles timezone-aware schedule configuration with validation.
 */

import { Router, Request, Response } from "express";
import { ScheduleValidationService } from "../services/digest/ScheduleValidationService";
import { DigestScheduler } from "../services/digest/DigestScheduler";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { QUEUE_NAMES } from "../queues/types";
import { sendError } from "../utils/errorResponse";
import { validateWalletAddress } from "../middleware/validation";
import {
  getAllValidTimezones,
  getCommonTimezones,
} from "../utils/timezoneValidator";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
const digestQueue = new Queue(QUEUE_NAMES.DIGEST_GENERATION, {
  connection: redis as any,
});

const validationService = new ScheduleValidationService();
const scheduler = new DigestScheduler(redis, digestQueue);

const digestScheduleRouter = Router();

/**
 * GET /api/digest/schedule/timezones
 * Get list of valid IANA timezones for UI dropdown
 */
digestScheduleRouter.get("/timezones", (req: Request, res: Response) => {
  try {
    const { common } = req.query;
    const timezones = common === "true" ? getCommonTimezones() : getAllValidTimezones();

    res.json({
      success: true,
      timezones,
      count: timezones.length,
    });
  } catch (error) {
    sendError(
      res,
      500,
      "TIMEZONE_LIST_FAILED",
      "Failed to retrieve timezone list"
    );
  }
});

/**
 * POST /api/digest/schedule/validate
 * Validate a schedule configuration without saving.
 * Useful for previewing and catching errors before saving.
 *
 * Request body:
 * {
 *   "timezone": "America/New_York",
 *   "weekday": 1,
 *   "hour": 9,
 *   "minute": 0
 * }
 */
digestScheduleRouter.post(
  "/validate",
  async (req: Request, res: Response) => {
    try {
      const result = validationService.validateAndCalculateNextExecution(
        req.body
      );

      res.json({
        success: result.valid,
        ...result,
        upcomingExecutions: result.valid
          ? validationService.getUpcomingExecutions(result.schedule!, 28)
          : undefined,
      });
    } catch (error) {
      sendError(
        res,
        500,
        "VALIDATION_FAILED",
        error instanceof Error ? error.message : "Failed to validate schedule"
      );
    }
  }
);

/**
 * POST /api/digest/schedule/:walletAddress/save
 * Save a validated schedule configuration for a user.
 *
 * Request body:
 * {
 *   "timezone": "America/New_York",
 *   "weekday": 1,
 *   "hour": 9,
 *   "minute": 0
 * }
 */
digestScheduleRouter.post(
  "/:walletAddress/save",
  validateWalletAddress,
  async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.params;

      // Validate the schedule
      const validationResult =
        validationService.validateAndCalculateNextExecution(req.body);

      if (!validationResult.valid || !validationResult.schedule) {
        return res.status(400).json({
          success: false,
          errors: validationResult.errors,
          warnings: validationResult.warnings,
        });
      }

      const schedule = validationResult.schedule;

      // Save to scheduler (this also registers the BullMQ job)
      const saveResult = await scheduler.configure(walletAddress, {
        mode: "weekly",
        timezone: schedule.timezone,
        deliveryTime: `${String(schedule.hour).padStart(2, "0")}:${String(
          schedule.minute
        ).padStart(2, "0")}`,
        dayOfWeek: schedule.weekday,
      });

      if (!saveResult.ok) {
        return res.status(400).json({
          success: false,
          error: saveResult.error,
        });
      }

      res.json({
        success: true,
        schedule,
        nextExecutionUTC: validationResult.nextExecutionUTC,
        nextExecutionLocal: validationResult.nextExecutionLocal,
        dstInfo: validationResult.dstInfo,
        upcomingExecutions: validationService.getUpcomingExecutions(
          schedule,
          28
        ),
        warnings: validationResult.warnings,
      });
    } catch (error) {
      sendError(
        res,
        500,
        "SCHEDULE_SAVE_FAILED",
        error instanceof Error ? error.message : "Failed to save schedule"
      );
    }
  }
);

/**
 * GET /api/digest/schedule/:walletAddress
 * Get the current schedule configuration for a user
 */
digestScheduleRouter.get(
  "/:walletAddress",
  validateWalletAddress,
  async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.params;

      const config = await scheduler.getConfig(walletAddress);

      if (!config) {
        return res.status(404).json({
          success: false,
          error: "SCHEDULE_NOT_FOUND",
          message: "No schedule configuration found for this wallet",
        });
      }

      // Parse the saved config and calculate next execution
      const hour = config.deliveryTime
        ? parseInt(config.deliveryTime.split(":")[0])
        : 0;
      const minute = config.deliveryTime
        ? parseInt(config.deliveryTime.split(":")[1])
        : 0;

      const schedule = {
        timezone: config.timezone || "UTC",
        weekday: config.dayOfWeek || 0,
        hour,
        minute,
      };

      const result =
        validationService.validateAndCalculateNextExecution(schedule);

      res.json({
        success: true,
        config,
        schedule,
        nextExecutionUTC: result.nextExecutionUTC,
        nextExecutionLocal: result.nextExecutionLocal,
        dstInfo: result.dstInfo,
        upcomingExecutions: validationService.getUpcomingExecutions(
          schedule,
          28
        ),
      });
    } catch (error) {
      sendError(
        res,
        500,
        "SCHEDULE_FETCH_FAILED",
        error instanceof Error ? error.message : "Failed to fetch schedule"
      );
    }
  }
);

/**
 * DELETE /api/digest/schedule/:walletAddress
 * Remove the schedule configuration for a user (stops digests)
 */
digestScheduleRouter.delete(
  "/:walletAddress",
  validateWalletAddress,
  async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.params;

      // Get current config to verify it exists
      const config = await scheduler.getConfig(walletAddress);
      if (!config) {
        return res.status(404).json({
          success: false,
          error: "SCHEDULE_NOT_FOUND",
        });
      }

      // Remove the repeatable job
      const jobName = `digest-${walletAddress}`;
      const repeatableJobs = await digestQueue.getRepeatableJobs();
      for (const job of repeatableJobs) {
        if (job.name === jobName) {
          await digestQueue.removeRepeatableByKey(job.key);
        }
      }

      // Delete from Redis
      const scheduleKey = `digest:schedule:${walletAddress}`;
      await redis.del(scheduleKey);

      res.json({
        success: true,
        message: "Schedule configuration deleted",
      });
    } catch (error) {
      sendError(
        res,
        500,
        "SCHEDULE_DELETE_FAILED",
        error instanceof Error ? error.message : "Failed to delete schedule"
      );
    }
  }
);

export default digestScheduleRouter;
