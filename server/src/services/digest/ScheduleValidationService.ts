/**
 * Schedule validation service for weekly digests.
 * Handles timezone-aware schedule validation and next execution time calculation
 * with proper daylight savings time (DST) boundary handling.
 */

import {
  validateWeeklyDigestSchedule,
  type WeeklyDigestSchedule,
  type ScheduleValidationResult,
  isDaylightSavingsBoundary,
} from "../../utils/digestScheduleValidator";
import {
  validateTimezone,
  resolveLocalTimeToUTC,
} from "../../utils/timezoneValidator";

export interface ScheduleValidationServiceResult {
  valid: boolean;
  schedule?: WeeklyDigestSchedule;
  nextExecutionUTC?: Date;
  nextExecutionLocal?: string; // Formatted as "YYYY-MM-DD HH:MM:SS"
  dstInfo?: {
    isDSTActive: boolean;
    message: string;
  };
  errors: Array<{ field: string; message: string }>;
  warnings: string[];
}

export class ScheduleValidationService {
  /**
   * Validate a schedule configuration and calculate next execution time.
   */
  validateAndCalculateNextExecution(
    input: unknown,
    referenceDate: Date = new Date(),
  ): ScheduleValidationServiceResult {
    // First, validate the schedule structure
    const validationResult = validateWeeklyDigestSchedule(input);

    if (!validationResult.valid || !validationResult.schedule) {
      return {
        valid: false,
        errors: validationResult.errors,
        warnings: validationResult.warnings,
      };
    }

    const schedule = validationResult.schedule;

    try {
      // Calculate next execution time
      const nextExecution = this.calculateNextExecutionTime(
        schedule,
        referenceDate,
      );

      // Check DST status
      const dstInfo = isDaylightSavingsBoundary(schedule, nextExecution);

      // Format local time
      const nextExecutionLocal = this.formatLocalTime(
        schedule.timezone,
        nextExecution,
      );

      return {
        valid: true,
        schedule,
        nextExecutionUTC: nextExecution,
        nextExecutionLocal,
        dstInfo,
        errors: [],
        warnings: validationResult.warnings,
      };
    } catch (error) {
      return {
        valid: false,
        schedule,
        errors: [
          {
            field: "schedule",
            message: `Failed to calculate next execution: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        warnings: validationResult.warnings,
      };
    }
  }

  /**
   * Calculate the next execution time for a given schedule.
   * Handles edge cases like DST transitions and non-existent times.
   */
  calculateNextExecutionTime(
    schedule: WeeklyDigestSchedule,
    referenceDate: Date = new Date(),
  ): Date {
    const now = new Date(referenceDate);
    const currentUTCHours = now.getUTCHours();
    const currentUTCMinutes = now.getUTCMinutes();

    // Target date is today at the scheduled time
    let targetDate = new Date(now);
    targetDate.setUTCHours(0, 0, 0, 0);

    // Try to resolve the local time to UTC
    let nextExecution = resolveLocalTimeToUTC(
      schedule.timezone,
      schedule.hour,
      schedule.minute,
      targetDate,
    );

    const targetWeekday = schedule.weekday;
    const currentWeekday = this.getWeekdayInTimezone(
      schedule.timezone,
      nextExecution,
    );

    // If we haven't reached the target weekday this week, add days
    let daysToAdd = 0;
    if (currentWeekday < targetWeekday) {
      daysToAdd = targetWeekday - currentWeekday;
    } else if (currentWeekday > targetWeekday) {
      daysToAdd = 7 - (currentWeekday - targetWeekday);
    } else {
      // Same weekday: check if time has passed
      if (nextExecution <= now) {
        daysToAdd = 7;
      }
    }

    if (daysToAdd > 0) {
      targetDate = new Date(targetDate.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
      nextExecution = resolveLocalTimeToUTC(
        schedule.timezone,
        schedule.hour,
        schedule.minute,
        targetDate,
      );
    }

    // Verify the result is correct
    this.verifyExecutionTime(schedule, nextExecution);

    return nextExecution;
  }

  /**
   * Get the weekday (0-6) for a given UTC date in the target timezone.
   */
  private getWeekdayInTimezone(timezone: string, utcDate: Date): number {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const formatted = formatter.format(utcDate);
    const [year, month, day] = formatted.split("-").map(Number);

    // Create a UTC date from the local date components
    const localDate = new Date(Date.UTC(year, month - 1, day));
    return localDate.getUTCDay();
  }

  /**
   * Verify that the calculated execution time is correct.
   * Throws if verification fails (helps catch DST edge cases).
   */
  private verifyExecutionTime(
    schedule: WeeklyDigestSchedule,
    executionUTC: Date,
  ): void {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: schedule.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const formatted = formatter.format(executionUTC);
    const [year, month, day, hour, minute, second] = formatted
      .split(/[-\s:]+/)
      .map(Number);

    // Verify hour and minute match
    if (hour !== schedule.hour || minute !== schedule.minute) {
      throw new Error(
        `Verification failed: expected ${schedule.hour}:${schedule.minute}, ` +
        `got ${hour}:${minute} in timezone ${schedule.timezone}. ` +
        `This may be due to a DST transition or ambiguous time.`,
      );
    }

    // Verify weekday matches
    const resultWeekday = this.getWeekdayInTimezone(
      schedule.timezone,
      executionUTC,
    );
    if (resultWeekday !== schedule.weekday) {
      throw new Error(
        `Weekday mismatch: expected ${schedule.weekday}, got ${resultWeekday}`,
      );
    }
  }

  /**
   * Format a UTC date as local time in the given timezone.
   */
  private formatLocalTime(timezone: string, utcDate: Date): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const formatted = formatter.format(utcDate);
    // formatted is YYYY-MM-DD HH:MM:SS
    return formatted;
  }

  /**
   * Check if a schedule would execute within the next N hours.
   */
  willExecuteSoon(
    schedule: WeeklyDigestSchedule,
    hoursFromNow: number = 24,
    referenceDate: Date = new Date(),
  ): boolean {
    const nextExecution = this.calculateNextExecutionTime(schedule, referenceDate);
    const deadline = new Date(referenceDate.getTime() + hoursFromNow * 60 * 60 * 1000);
    return nextExecution <= deadline;
  }

  /**
   * Get all execution times for a schedule over the next N days.
   * Useful for previewing when digests will be generated.
   */
  getUpcomingExecutions(
    schedule: WeeklyDigestSchedule,
    daysAhead: number = 28,
    referenceDate: Date = new Date(),
  ): Array<{
    executionUTC: Date;
    executionLocal: string;
    daysFromNow: number;
  }> {
    const executions = [];
    let current = new Date(referenceDate);

    for (let i = 0; i < daysAhead; i++) {
      current = new Date(current.getTime() + 24 * 60 * 60 * 1000);

      try {
        const execution = this.calculateNextExecutionTime(schedule, current);

        // Check if this is a new execution (not duplicate from same day)
        if (
          !executions.length ||
          execution.getTime() !== executions[executions.length - 1].executionUTC.getTime()
        ) {
          executions.push({
            executionUTC: execution,
            executionLocal: this.formatLocalTime(schedule.timezone, execution),
            daysFromNow: Math.ceil(
              (execution.getTime() - referenceDate.getTime()) / (24 * 60 * 60 * 1000)
            ),
          });

          // Stop when we have one execution
          if (executions.length === 1) break;
        }
      } catch {
        // Skip on error (edge case like ambiguous DST times)
        continue;
      }
    }

    return executions;
  }
}
