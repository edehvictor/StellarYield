// ─── Timezone normalization for weekly campaign windows (#965) ────────────
//
// A `Date` in JavaScript is always a UTC instant internally — there is no
// such thing as a "local Date". The actual timezone problem lives at the
// *authoring* boundary: a campaign manager enters a wall-clock window
// ("Monday 00:00") in their own timezone, and that has to become one
// unambiguous UTC instant before it is ever persisted. From then on, every
// stored schedule window (`startDate` / `endDate` on RewardScheduleLike) is
// UTC and must never be reinterpreted in a different zone. Renderers read
// that stored UTC instant and format it for display in whatever timezone a
// viewer needs — formatting never mutates or feeds back into the stored
// window. See docs/reward-schedule-authoring.md for authoring guidance.

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A wall-clock date/time as authored by a human, with no attached zone. */
export interface WallClockDateTime {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** A wall-clock moment paired with the IANA timezone it was authored in. */
export interface ZonedWallClock {
  wallClock: WallClockDateTime;
  /** IANA timezone identifier, e.g. "America/New_York". */
  timeZone: string;
}

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function partsToMap(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }
  return map;
}

/**
 * The offset (in ms) that must be *added* to `instant`'s UTC time to reach
 * the wall-clock time as it appears in `timeZone` at that instant. Uses the
 * live IANA rules via Intl, so it is correct across DST transitions rather
 * than assuming a fixed offset for the zone.
 */
export function getTimeZoneOffsetMs(instant: Date, timeZone: string): number {
  const map = partsToMap(offsetFormatter(timeZone).formatToParts(instant));
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - instant.getTime();
}

/**
 * Convert a wall-clock date/time authored in `timeZone` into the precise
 * UTC instant it represents. Handles DST transitions by measuring the
 * actual offset in effect for that timezone at that date rather than a
 * fixed offset, with one correction pass in case the initial guess landed
 * on the wrong side of a transition.
 */
export function wallClockToUtc(zoned: ZonedWallClock): Date {
  const { year, month, day, hour, minute } = zoned.wallClock;
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  const firstOffset = getTimeZoneOffsetMs(new Date(guessUtcMs), zoned.timeZone);
  const correctedMs = guessUtcMs - firstOffset;

  const secondOffset = getTimeZoneOffsetMs(new Date(correctedMs), zoned.timeZone);
  const finalMs = secondOffset === firstOffset ? correctedMs : guessUtcMs - secondOffset;

  return new Date(finalMs);
}

/** The result of rendering a stored UTC instant for display in a target timezone. */
export interface RenderedLocalTime {
  /** ISO-8601 string with the target zone's UTC offset, e.g. "2026-05-04T09:00:00-04:00". */
  isoLocal: string;
  timeZone: string;
  /** Offset from UTC in effect at this instant, in minutes (e.g. -240 for EDT). */
  utcOffsetMinutes: number;
}

/**
 * Render a stored UTC instant in `timeZone` for display purposes. This is a
 * pure read: it never changes the stored window, only how it is presented.
 */
export function renderInTimeZone(utcInstant: Date, timeZone: string): RenderedLocalTime {
  const offsetMs = getTimeZoneOffsetMs(utcInstant, timeZone);
  const offsetMinutes = Math.round(offsetMs / MS_PER_MINUTE);

  const map = partsToMap(offsetFormatter(timeZone).formatToParts(utcInstant));
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const offsetMins = String(absMinutes % 60).padStart(2, "0");

  const isoLocal =
    `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}` +
    `${sign}${offsetHours}:${offsetMins}`;

  return { isoLocal, timeZone, utcOffsetMinutes: offsetMinutes };
}

/** A schedule window as authored, before normalization. */
export interface AuthoredScheduleWindow {
  start: Date | ZonedWallClock;
  end: Date | ZonedWallClock;
}

export interface NormalizedScheduleWindow {
  startDate: Date;
  endDate: Date;
}

function isZonedWallClock(value: Date | ZonedWallClock): value is ZonedWallClock {
  return !(value instanceof Date);
}

/**
 * Normalize an authored campaign window to UTC `Date`s suitable for
 * storage. Values that are already `Date` instances pass through unchanged
 * (they are already UTC instants); wall-clock values authored in a named
 * timezone are converted via `wallClockToUtc`.
 *
 * Throws if the normalized end is not strictly after the normalized start.
 */
export function normalizeScheduleWindowToUtc(
  window: AuthoredScheduleWindow,
): NormalizedScheduleWindow {
  const startDate = isZonedWallClock(window.start)
    ? wallClockToUtc(window.start)
    : window.start;
  const endDate = isZonedWallClock(window.end) ? wallClockToUtc(window.end) : window.end;

  if (endDate.getTime() <= startDate.getTime()) {
    throw new Error(
      "Schedule window end must be strictly after start once normalized to UTC.",
    );
  }

  return { startDate, endDate };
}

// ─── ISO week (UTC) helpers for weekly campaign rollover (#965) ───────────
//
// Weekly campaign boundaries are defined purely in UTC clock terms — Monday
// 00:00:00.000 UTC through the following Monday 00:00:00.000 UTC (exclusive)
// — independent of any viewer's local timezone. This keeps "which week does
// this claim belong to" unambiguous regardless of where a schedule is
// authored or where a claimant happens to be.

/** Start of the UTC ISO week (Monday 00:00:00.000 UTC) containing `instant`. */
export function startOfIsoWeekUtc(instant: Date): Date {
  const utcDay = instant.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  const isoDayIndex = utcDay === 0 ? 7 : utcDay; // Mon=1 .. Sun=7
  const daysSinceMonday = isoDayIndex - 1;

  const startOfDayUtc = Date.UTC(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate(),
    0,
    0,
    0,
    0,
  );

  return new Date(startOfDayUtc - daysSinceMonday * MS_PER_DAY);
}

/** Start of the *next* UTC ISO week — i.e. the exclusive end of the current one. */
export function endOfIsoWeekUtc(instant: Date): Date {
  return new Date(startOfIsoWeekUtc(instant).getTime() + 7 * MS_PER_DAY);
}

/** Whether `a` and `b` fall within the same UTC ISO week (Mon–Sun). */
export function isSameIsoWeekUtc(a: Date, b: Date): boolean {
  return startOfIsoWeekUtc(a).getTime() === startOfIsoWeekUtc(b).getTime();
}

export interface RewardScheduleLike {
  protocolName: string;
  tokenSymbol: string;
  dailyEmission: number;
  startDate: Date;
  endDate: Date;
  sourceProvenance: string;
  confidence?: "low" | "medium" | "high";
  isActive: boolean;
  events: Array<{
    type: string;
    date: Date;
  }>;
}

export type RewardScheduleStatus =
  | "active"
  | "expiring"
  | "expired"
  | "inactive";

export type RewardScheduleWarningLevel = "info" | "warning" | "critical";

export interface RewardScheduleMonitorInput extends RewardScheduleLike {
  lastClaimAt?: Date | null;
}

export interface RewardScheduleHealthSummary {
  protocolName: string;
  tokenSymbol: string;
  status: RewardScheduleStatus;
  warningLevel: RewardScheduleWarningLevel;
  daysUntilEnd: number;
  hasRecentClaims: boolean;
  message: string;
}

export interface RewardScheduleHealthOptions {
  now?: Date;
  expiringWithinDays?: number;
  inactiveClaimWindowDays?: number;
}

function toWholeDays(valueMs: number): number {
  return Math.ceil(valueMs / (1000 * 60 * 60 * 24));
}

export function summarizeRewardScheduleHealth(
  schedule: RewardScheduleMonitorInput,
  options: RewardScheduleHealthOptions = {},
): RewardScheduleHealthSummary {
  const now = options.now ?? new Date();
  const expiringWithinDays = options.expiringWithinDays ?? 14;
  const inactiveClaimWindowDays = options.inactiveClaimWindowDays ?? 21;
  const daysUntilEnd = toWholeDays(schedule.endDate.getTime() - now.getTime());

  const hasRecentClaims = schedule.lastClaimAt
    ? now.getTime() - schedule.lastClaimAt.getTime() <=
      inactiveClaimWindowDays * 24 * 60 * 60 * 1000
    : false;

  if (!schedule.isActive) {
    return {
      protocolName: schedule.protocolName,
      tokenSymbol: schedule.tokenSymbol,
      status: "inactive",
      warningLevel: "warning",
      daysUntilEnd,
      hasRecentClaims,
      message: "Schedule is inactive and should be reviewed before future distributions.",
    };
  }

  if (schedule.endDate.getTime() < now.getTime()) {
    return {
      protocolName: schedule.protocolName,
      tokenSymbol: schedule.tokenSymbol,
      status: "expired",
      warningLevel: "critical",
      daysUntilEnd,
      hasRecentClaims,
      message: "Schedule has expired and no longer contributes rewards.",
    };
  }

  if (daysUntilEnd <= expiringWithinDays || !hasRecentClaims) {
    return {
      protocolName: schedule.protocolName,
      tokenSymbol: schedule.tokenSymbol,
      status: "expiring",
      warningLevel: !hasRecentClaims ? "critical" : "warning",
      daysUntilEnd,
      hasRecentClaims,
      message: !hasRecentClaims
        ? "Schedule is nearing expiry and has no recent claims."
        : `Schedule expires within ${expiringWithinDays} days.`,
    };
  }

  return {
    protocolName: schedule.protocolName,
    tokenSymbol: schedule.tokenSymbol,
    status: "active",
    warningLevel: "info",
    daysUntilEnd,
    hasRecentClaims,
    message: "Schedule is active and claims activity looks healthy.",
  };
}
