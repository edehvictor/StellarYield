/**
 * Timezone validation utility with fallback logic for deprecated/invalid timezones.
 * Validates IANA timezone names and provides safe defaults.
 */

// Standard IANA timezone database (common timezones)
const VALID_TIMEZONES = new Set([
  // UTC
  "UTC",
  "Etc/UTC",
  
  // Americas
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Mexico_City",
  "America/Buenos_Aires",
  "America/Sao_Paulo",
  
  // Europe
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "Europe/Brussels",
  "Europe/Vienna",
  "Europe/Prague",
  "Europe/Warsaw",
  "Europe/Moscow",
  "Europe/Istanbul",
  
  // Africa
  "Africa/Cairo",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Africa/Nairobi",
  
  // Asia
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Manila",
  "Asia/Jakarta",
  
  // Australia
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Perth",
  "Australia/Adelaide",
  
  // Pacific
  "Pacific/Auckland",
  "Pacific/Fiji",
]);

// Map of deprecated or common aliases to valid IANA names
const TIMEZONE_FALLBACKS: Record<string, string> = {
  // Common misspellings and aliases
  "EST": "America/New_York",
  "CST": "America/Chicago",
  "MST": "America/Denver",
  "PST": "America/Los_Angeles",
  "GMT": "UTC",
  "UTC+0": "UTC",
  "Zulu": "UTC",
  
  // Old POSIX timezone names (deprecated)
  "US/Eastern": "America/New_York",
  "US/Central": "America/Chicago",
  "US/Mountain": "America/Denver",
  "US/Pacific": "America/Los_Angeles",
  "US/Alaska": "America/Anchorage",
  "US/Hawaii": "Pacific/Honolulu",
  "Canada/Eastern": "America/Toronto",
  "Canada/Central": "America/Chicago",
  "Canada/Mountain": "America/Denver",
  "Canada/Pacific": "America/Vancouver",
  
  // Europe legacy names
  "Europe/Dublin": "Europe/London",
  "GB": "Europe/London",
  "GB-Eire": "Europe/London",
  
  // Asia legacy
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Calcutta": "Asia/Kolkata",
  
  // Australia legacy
  "Australia/ACT": "Australia/Sydney",
  "Australia/NSW": "Australia/Sydney",
  "Australia/Queensland": "Australia/Brisbane",
  "Australia/South": "Australia/Adelaide",
  "Australia/Tasmania": "Australia/Hobart",
  "Australia/Victoria": "Australia/Melbourne",
  "Australia/West": "Australia/Perth",
};

export interface TimezoneValidationResult {
  valid: boolean;
  timezone: string; // Always a valid IANA timezone
  original: string; // The input timezone
  wasFallback: boolean; // True if fallback was applied
  warning?: string; // Warning message if fallback was applied
}

/**
 * Validate a timezone string and return a safe, valid timezone.
 * Falls back to UTC if the timezone is invalid.
 * 
 * @param tz - The timezone string to validate
 * @returns ValidationResult with a guaranteed-valid timezone
 */
export function validateTimezone(tz: string | undefined | null): TimezoneValidationResult {
  const original = tz?.trim() || "";

  // Check if it's already valid
  if (VALID_TIMEZONES.has(original)) {
    return {
      valid: true,
      timezone: original,
      original,
      wasFallback: false,
    };
  }

  // Try to find a fallback
  if (original in TIMEZONE_FALLBACKS) {
    const fallback = TIMEZONE_FALLBACKS[original];
    return {
      valid: true,
      timezone: fallback,
      original,
      wasFallback: true,
      warning: `Timezone "${original}" is deprecated or invalid. Using fallback: "${fallback}"`,
    };
  }

  // Last resort: validate against browser/Node.js Intl API
  try {
    Intl.DateTimeFormat(undefined, { timeZone: original });
    // If no error, it's valid
    return {
      valid: true,
      timezone: original,
      original,
      wasFallback: false,
    };
  } catch {
    // Invalid timezone - fall back to UTC
    return {
      valid: false,
      timezone: "UTC",
      original,
      wasFallback: true,
      warning: `Timezone "${original}" is not recognized. Falling back to UTC.`,
    };
  }
}

/**
 * Check if a timezone is valid without applying fallback logic.
 * Useful for strict validation.
 */
export function isValidTimezone(tz: string | undefined | null): boolean {
  if (!tz) return false;
  const trimmed = tz.trim();
  
  if (VALID_TIMEZONES.has(trimmed)) {
    return true;
  }

  // Check Intl API
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the list of all valid IANA timezones.
 * Sorted alphabetically for UI display.
 */
export function getAllValidTimezones(): string[] {
  return Array.from(VALID_TIMEZONES).sort();
}

/**
 * Get common timezones (frequently used subset for UI dropdowns).
 */
export function getCommonTimezones(): string[] {
  const common = [
    "UTC",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Asia/Dubai",
    "Asia/Kolkata",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
    "Pacific/Auckland",
  ];
  return common;
}

/**
 * Format a timezone for display (human-readable).
 * Converts "America/New_York" to "New York (UTC-5/-4)".
 */
export function formatTimezoneForDisplay(tz: string): string {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    });
    
    // Get the short timezone name (e.g., "EST" or "EDT")
    const parts = formatter.formatToParts(now);
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value || tz;
    
    // Format as "Location (Offset)"
    const location = tz.replace(/_/g, " ");
    return `${location} (${tzName})`;
  } catch {
    return tz;
  }
}

/**
 * Resolve a time in a given timezone to UTC.
 * Useful for scheduling tasks at specific local times.
 * 
 * @param timezone - IANA timezone name
 * @param hour - Hour in 24-hour format (0-23)
 * @param minute - Minute (0-59)
 * @param date - Optional date; defaults to today
 * @returns Date object in UTC representing when that local time occurs
 */
export function resolveLocalTimeToUTC(
  timezone: string,
  hour: number,
  minute: number,
  date: Date = new Date(),
): Date {
  // Validate input
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time: ${hour}:${minute}`);
  }

  // Create a formatter for the target timezone
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

  // Start with the given date at 00:00:00 UTC
  const testDate = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
  ));

  // Format to get the local date/time at UTC 00:00:00
  const formatted = formatter.format(testDate);
  const [testYear, testMonth, testDay, testHour, testMinute, testSecond] =
    formatted.split(/[-\s:]+/).map(Number);

  // Calculate offset: how many milliseconds ahead is the test date's local time from UTC midnight
  const testLocalHours = testHour + testMinute / 60 + testSecond / 3600;
  const offsetHours = testLocalHours - 0; // 0 is UTC hour at this moment

  // Now calculate what UTC time corresponds to the target local time
  const targetLocalHours = hour + minute / 60;
  const diffHours = targetLocalHours - offsetHours;

  // Create the result date
  const result = new Date(testDate.getTime() + diffHours * 3600_000);

  // Verify by formatting back (handles DST edge cases)
  const verifyParts = formatter.formatToParts(result);
  const verifyHour = parseInt(verifyParts.find((p) => p.type === "hour")?.value || "0");
  const verifyMinute = parseInt(verifyParts.find((p) => p.type === "minute")?.value || "0");

  if (verifyHour !== hour || verifyMinute !== minute) {
    // Adjustment needed (likely DST edge case)
    const correction = (hour - verifyHour + 24) % 24;
    return new Date(result.getTime() + correction * 3600_000);
  }

  return result;
}
