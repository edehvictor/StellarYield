/**
 * Schedule validation for weekly digests.
 * Validates timezone, weekday, and time fields with clear error messages.
 */

import { validateTimezone, isValidTimezone } from "./timezoneValidator";

export interface WeeklyDigestSchedule {
  timezone: string;        // IANA timezone name
  weekday: number;         // 0 = Sunday, 6 = Saturday
  hour: number;            // 0-23 in local timezone
  minute: number;          // 0-59
}

export interface ScheduleValidationError {
  field: string;
  message: string;
  value?: unknown;
}

export interface ScheduleValidationResult {
  valid: boolean;
  schedule?: WeeklyDigestSchedule;
  errors: ScheduleValidationError[];
  warnings: string[];
}

/**
 * Validate a weekly digest schedule configuration.
 * Returns detailed error messages for each field.
 * Applies timezone fallback logic automatically.
 */
export function validateWeeklyDigestSchedule(
  input: unknown,
): ScheduleValidationResult {
  const errors: ScheduleValidationError[] = [];
  const warnings: string[] = [];

  if (!input || typeof input !== "object") {
    return {
      valid: false,
      errors: [
        {
          field: "root",
          message: "Schedule must be an object",
          value: input,
        },
      ],
      warnings: [],
    };
  }

  const obj = input as Record<string, unknown>;

  // Validate timezone
  let validatedTimezone = "UTC";
  const rawTimezone = obj.timezone;
  
  if (!rawTimezone) {
    errors.push({
      field: "timezone",
      message: "Timezone is required",
    });
  } else if (typeof rawTimezone !== "string") {
    errors.push({
      field: "timezone",
      message: "Timezone must be a string",
      value: rawTimezone,
    });
  } else {
    const tzResult = validateTimezone(rawTimezone);
    validatedTimezone = tzResult.timezone;
    
    if (!tzResult.valid) {
      warnings.push(
        tzResult.warning || `Invalid timezone: "${rawTimezone}". Using UTC.`,
      );
    } else if (tzResult.wasFallback) {
      warnings.push(tzResult.warning || `Timezone "${rawTimezone}" is deprecated. Using "${validatedTimezone}".`);
    }
  }

  // Validate weekday
  let validatedWeekday = 0;
  const rawWeekday = obj.weekday;
  
  if (rawWeekday === undefined) {
    errors.push({
      field: "weekday",
      message: "Weekday is required (0-6, where 0 = Sunday)",
    });
  } else if (typeof rawWeekday !== "number") {
    errors.push({
      field: "weekday",
      message: "Weekday must be a number between 0 and 6",
      value: rawWeekday,
    });
  } else if (!Number.isInteger(rawWeekday)) {
    errors.push({
      field: "weekday",
      message: "Weekday must be an integer",
      value: rawWeekday,
    });
  } else if (rawWeekday < 0 || rawWeekday > 6) {
    errors.push({
      field: "weekday",
      message: "Weekday must be between 0 and 6 (0 = Sunday, 6 = Saturday)",
      value: rawWeekday,
    });
  } else {
    validatedWeekday = rawWeekday;
  }

  // Validate hour
  let validatedHour = 0;
  const rawHour = obj.hour;
  
  if (rawHour === undefined) {
    errors.push({
      field: "hour",
      message: "Hour is required (0-23)",
    });
  } else if (typeof rawHour !== "number") {
    errors.push({
      field: "hour",
      message: "Hour must be a number between 0 and 23",
      value: rawHour,
    });
  } else if (!Number.isInteger(rawHour)) {
    errors.push({
      field: "hour",
      message: "Hour must be an integer",
      value: rawHour,
    });
  } else if (rawHour < 0 || rawHour > 23) {
    errors.push({
      field: "hour",
      message: "Hour must be between 0 and 23",
      value: rawHour,
    });
  } else {
    validatedHour = rawHour;
  }

  // Validate minute
  let validatedMinute = 0;
  const rawMinute = obj.minute;
  
  if (rawMinute === undefined) {
    errors.push({
      field: "minute",
      message: "Minute is required (0-59)",
    });
  } else if (typeof rawMinute !== "number") {
    errors.push({
      field: "minute",
      message: "Minute must be a number between 0 and 59",
      value: rawMinute,
    });
  } else if (!Number.isInteger(rawMinute)) {
    errors.push({
      field: "minute",
      message: "Minute must be an integer",
      value: rawMinute,
    });
  } else if (rawMinute < 0 || rawMinute > 59) {
    errors.push({
      field: "minute",
      message: "Minute must be between 0 and 59",
      value: rawMinute,
    });
  } else {
    validatedMinute = rawMinute;
  }

  const schedule: WeeklyDigestSchedule = {
    timezone: validatedTimezone,
    weekday: validatedWeekday,
    hour: validatedHour,
    minute: validatedMinute,
  };

  return {
    valid: errors.length === 0,
    schedule: errors.length === 0 ? schedule : undefined,
    errors,
    warnings,
  };
}

/**
 * Get human-readable name for a weekday number.
 */
export function getWeekdayName(weekday: number): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[weekday] || "Unknown";
}

/**
 * Format a schedule for display.
 */
export function formatScheduleForDisplay(schedule: WeeklyDigestSchedule): string {
  const day = getWeekdayName(schedule.weekday);
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  return `${day} at ${time} ${schedule.timezone}`;
}

/**
 * Check if a time in the given timezone falls on a daylight saving boundary.
 * Returns info about whether DST is active and when the next transition is.
 */
export function isDaylightSavingsBoundary(
  schedule: WeeklyDigestSchedule,
  date: Date = new Date(),
): {
  isDSTActive: boolean;
  nextTransition?: Date;
  message?: string;
} {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: schedule.timezone,
      timeZoneName: "long",
    });

    const parts = formatter.formatToParts(date);
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "";

    // Check if "Daylight" or "Summer" is in the timezone name
    const isDST = /daylight|summer/.test(tzName.toLowerCase());

    return {
      isDSTActive: isDST,
      message: isDST ? "Daylight saving time is active" : "Standard time is active",
    };
  } catch {
    return {
      isDSTActive: false,
      message: "Could not determine DST status",
    };
  }
}
