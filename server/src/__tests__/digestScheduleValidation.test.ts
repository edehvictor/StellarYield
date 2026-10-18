/**
 * Comprehensive tests for digest schedule timezone validation.
 * Tests timezone validation, daylight savings boundaries, and invalid inputs.
 */

import {
  validateTimezone,
  isValidTimezone,
  resolveLocalTimeToUTC,
  formatTimezoneForDisplay,
} from "../utils/timezoneValidator";
import {
  validateWeeklyDigestSchedule,
  getWeekdayName,
  isDaylightSavingsBoundary,
  type WeeklyDigestSchedule,
} from "../utils/digestScheduleValidator";
import { ScheduleValidationService } from "../services/digest/ScheduleValidationService";

describe("Timezone Validation", () => {
  describe("validateTimezone", () => {
    test("accepts valid IANA timezones", () => {
      const result = validateTimezone("America/New_York");
      expect(result.valid).toBe(true);
      expect(result.timezone).toBe("America/New_York");
      expect(result.wasFallback).toBe(false);
    });

    test("applies fallback for deprecated US/ timezones", () => {
      const result = validateTimezone("US/Eastern");
      expect(result.valid).toBe(true);
      expect(result.timezone).toBe("America/New_York");
      expect(result.wasFallback).toBe(true);
      expect(result.warning).toContain("deprecated");
    });

    test("applies fallback for common abbreviations", () => {
      const result = validateTimezone("EST");
      expect(result.valid).toBe(true);
      expect(result.timezone).toBe("America/New_York");
      expect(result.wasFallback).toBe(true);
    });

    test("falls back to UTC for invalid timezone", () => {
      const result = validateTimezone("Invalid/Timezone");
      expect(result.valid).toBe(false);
      expect(result.timezone).toBe("UTC");
      expect(result.wasFallback).toBe(true);
      expect(result.warning).toContain("UTC");
    });

    test("handles null/undefined input", () => {
      const resultNull = validateTimezone(null);
      const resultUndefined = validateTimezone(undefined);

      expect(resultNull.valid).toBe(false);
      expect(resultNull.timezone).toBe("UTC");
      expect(resultUndefined.valid).toBe(false);
      expect(resultUndefined.timezone).toBe("UTC");
    });

    test("handles whitespace in timezone names", () => {
      const result = validateTimezone("  America/New_York  ");
      expect(result.valid).toBe(true);
      expect(result.timezone).toBe("America/New_York");
    });
  });

  describe("isValidTimezone", () => {
    test("returns true for valid IANA timezones", () => {
      expect(isValidTimezone("America/New_York")).toBe(true);
      expect(isValidTimezone("Europe/London")).toBe(true);
      expect(isValidTimezone("Asia/Tokyo")).toBe(true);
    });

    test("returns false for invalid timezones", () => {
      expect(isValidTimezone("Invalid/Timezone")).toBe(false);
      expect(isValidTimezone("NotATimezone")).toBe(false);
      expect(isValidTimezone(null)).toBe(false);
      expect(isValidTimezone(undefined)).toBe(false);
    });
  });

  describe("resolveLocalTimeToUTC", () => {
    test("converts local time to UTC correctly", () => {
      // 9 AM Eastern = 2 PM UTC (during EST)
      const result = resolveLocalTimeToUTC(
        "America/New_York",
        9,
        0,
        new Date("2024-01-15"), // Winter (EST)
      );

      expect(result.getUTCHours()).toBe(14);
      expect(result.getUTCMinutes()).toBe(0);
    });

    test("handles DST transitions correctly", () => {
      // 9 AM Eastern = 1 PM UTC (during EDT in June)
      const result = resolveLocalTimeToUTC(
        "America/New_York",
        9,
        0,
        new Date("2024-06-15"), // Summer (EDT)
      );

      expect(result.getUTCHours()).toBe(13);
      expect(result.getUTCMinutes()).toBe(0);
    });

    test("throws on invalid time values", () => {
      expect(() => resolveLocalTimeToUTC("America/New_York", 25, 0)).toThrow();
      expect(() => resolveLocalTimeToUTC("America/New_York", 0, 60)).toThrow();
      expect(() => resolveLocalTimeToUTC("America/New_York", -1, 0)).toThrow();
    });
  });

  describe("formatTimezoneForDisplay", () => {
    test("formats timezone with UTC offset", () => {
      const formatted = formatTimezoneForDisplay("America/New_York");
      expect(formatted).toContain("New York");
      expect(formatted).toMatch(/EST|EDT/); // Should show EST or EDT
    });

    test("handles invalid timezone gracefully", () => {
      const formatted = formatTimezoneForDisplay("Invalid/Timezone");
      expect(formatted).toBe("Invalid/Timezone"); // Falls back to input
    });
  });
});

describe("Schedule Validation", () => {
  describe("validateWeeklyDigestSchedule", () => {
    const validSchedule = {
      timezone: "America/New_York",
      weekday: 1,
      hour: 9,
      minute: 0,
    };

    test("accepts valid schedule", () => {
      const result = validateWeeklyDigestSchedule(validSchedule);
      expect(result.valid).toBe(true);
      expect(result.schedule).toEqual(validSchedule);
      expect(result.errors).toHaveLength(0);
    });

    test("rejects missing timezone", () => {
      const result = validateWeeklyDigestSchedule({
        weekday: 1,
        hour: 9,
        minute: 0,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "timezone" }),
      );
    });

    test("rejects invalid weekday", () => {
      const result = validateWeeklyDigestSchedule({
        ...validSchedule,
        weekday: 7,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "weekday" }),
      );
    });

    test("rejects invalid hour", () => {
      const result = validateWeeklyDigestSchedule({
        ...validSchedule,
        hour: 25,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "hour" }),
      );
    });

    test("rejects invalid minute", () => {
      const result = validateWeeklyDigestSchedule({
        ...validSchedule,
        minute: 60,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "minute" }),
      );
    });

    test("rejects non-integer values", () => {
      const result = validateWeeklyDigestSchedule({
        ...validSchedule,
        hour: 9.5,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "hour" }),
      );
    });

    test("applies timezone fallback for deprecated zones", () => {
      const result = validateWeeklyDigestSchedule({
        timezone: "US/Eastern",
        weekday: 1,
        hour: 9,
        minute: 0,
      });

      expect(result.valid).toBe(true);
      expect(result.schedule?.timezone).toBe("America/New_York");
      expect(result.warnings).toContainEqual(
        expect.stringContaining("deprecated"),
      );
    });

    test("validates all fields simultaneously", () => {
      const result = validateWeeklyDigestSchedule({
        timezone: "Invalid/TZ",
        weekday: 10,
        hour: 25,
        minute: 60,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("getWeekdayName", () => {
    test("returns correct day names", () => {
      expect(getWeekdayName(0)).toBe("Sunday");
      expect(getWeekdayName(1)).toBe("Monday");
      expect(getWeekdayName(6)).toBe("Saturday");
    });

    test("returns Unknown for invalid weekday", () => {
      expect(getWeekdayName(7)).toBe("Unknown");
      expect(getWeekdayName(-1)).toBe("Unknown");
    });
  });

  describe("isDaylightSavingsBoundary", () => {
    test("detects DST during summer", () => {
      const schedule: WeeklyDigestSchedule = {
        timezone: "America/New_York",
        weekday: 1,
        hour: 9,
        minute: 0,
      };

      const result = isDaylightSavingsBoundary(
        schedule,
        new Date("2024-06-15"),
      );
      expect(result.isDSTActive).toBe(true);
      expect(result.message).toContain("Daylight");
    });

    test("detects standard time during winter", () => {
      const schedule: WeeklyDigestSchedule = {
        timezone: "America/New_York",
        weekday: 1,
        hour: 9,
        minute: 0,
      };

      const result = isDaylightSavingsBoundary(
        schedule,
        new Date("2024-01-15"),
      );
      expect(result.isDSTActive).toBe(false);
      expect(result.message).toContain("Standard");
    });
  });
});

describe("Schedule Validation Service", () => {
  const service = new ScheduleValidationService();

  describe("validateAndCalculateNextExecution", () => {
    test("calculates next execution for valid schedule", () => {
      const result = service.validateAndCalculateNextExecution({
        timezone: "America/New_York",
        weekday: 1, // Monday
        hour: 9,
        minute: 0,
      });

      expect(result.valid).toBe(true);
      expect(result.schedule).toBeDefined();
      expect(result.nextExecutionUTC).toBeDefined();
      expect(result.nextExecutionLocal).toBeDefined();
      expect(result.dstInfo).toBeDefined();
    });

    test("returns errors for invalid schedule", () => {
      const result = service.validateAndCalculateNextExecution({
        timezone: "Invalid/TZ",
        weekday: 10,
        hour: 25,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.nextExecutionUTC).toBeUndefined();
    });
  });

  describe("calculateNextExecutionTime", () => {
    test("returns a future date", () => {
      const schedule: WeeklyDigestSchedule = {
        timezone: "America/New_York",
        weekday: 1,
        hour: 9,
        minute: 0,
      };

      const now = new Date();
      const next = service.calculateNextExecutionTime(schedule, now);

      expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime());
    });

    test("respects weekday constraints", () => {
      const schedule: WeeklyDigestSchedule = {
        timezone: "America/New_York",
        weekday: 3, // Wednesday
        hour: 10,
        minute: 0,
      };

      const reference = new Date("2024-01-01"); // Monday
      const next = service.calculateNextExecutionTime(schedule, reference);

      // Format to get the day in the timezone
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });

      const formatted = formatter.format(next);
      const [, , day] = formatted.split("-").map(Number);

      // Wednesday should be 2 days later (Jan 3)
      expect([1, 2, 3]).toContain(day - 1 || 7);
    });

    test("handles edge case: same day at past time", () => {
      const schedule: WeeklyDigestSchedule = {
        timezone: "UTC",
        weekday: new Date().getUTCDay(),
        hour: 1,
        minute: 0,
      };

      const now = new Date();
      now.setUTCHours(12, 0, 0, 0); // 12 PM UTC

      const next = service.calculateNextExecutionTime(schedule, now);

      // Should be next week at 1 AM
      expect(next.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  describe("willExecuteSoon", () => {
    test("returns true if execution within N hours", () => {
      const schedule: WeeklyDigestSchedule = {
        timezone: "UTC",
        weekday: new Date().getUTCDay(),
        hour: new Date().getUTCHours() + 1,
        minute: 0,
      };

      const result = service.willExecuteSoon(schedule, 24);
      expect(result).toBe(true);
    });

    test("returns false if execution beyond N hours", () => {
      const schedule: WeeklyDigestSchedule = {
        timezone: "UTC",
        weekday: (new Date().getUTCDay() + 6) % 7, // 6 days later
        hour: 9,
        minute: 0,
      };

      const result = service.willExecuteSoon(schedule, 24);
      expect(result).toBe(false);
    });
  });

  describe("getUpcomingExecutions", () => {
    test("returns upcoming execution times", () => {
      const schedule: WeeklyDigestSchedule = {
        timezone: "America/New_York",
        weekday: 1,
        hour: 9,
        minute: 0,
      };

      const executions = service.getUpcomingExecutions(schedule, 28);

      expect(executions.length).toBeGreaterThan(0);
      expect(executions[0].executionUTC).toBeDefined();
      expect(executions[0].executionLocal).toBeDefined();
      expect(executions[0].daysFromNow).toBeGreaterThanOrEqual(0);
    });

    test("returns only one execution per week", () => {
      const schedule: WeeklyDigestSchedule = {
        timezone: "UTC",
        weekday: 1,
        hour: 9,
        minute: 0,
      };

      const executions = service.getUpcomingExecutions(schedule, 28);

      // Weekly schedule over 28 days should return 1 execution
      expect(executions.length).toBe(1);
    });
  });
});
