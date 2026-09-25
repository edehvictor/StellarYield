import {
  summarizeRewardScheduleHealth,
  wallClockToUtc,
  renderInTimeZone,
  normalizeScheduleWindowToUtc,
  startOfIsoWeekUtc,
  endOfIsoWeekUtc,
  isSameIsoWeekUtc,
  type RewardScheduleMonitorInput,
} from "../scheduleHealth";

const baseSchedule: RewardScheduleMonitorInput = {
  protocolName: "Blend",
  tokenSymbol: "BLND",
  dailyEmission: 100,
  startDate: new Date("2026-05-01T00:00:00Z"),
  endDate: new Date("2026-06-30T00:00:00Z"),
  sourceProvenance: "indexer",
  confidence: "high",
  isActive: true,
  events: [],
  lastClaimAt: new Date("2026-05-26T00:00:00Z"),
};

describe("summarizeRewardScheduleHealth", () => {
  const now = new Date("2026-05-27T00:00:00Z");

  it("marks healthy schedules as active", () => {
    const summary = summarizeRewardScheduleHealth(baseSchedule, { now });
    expect(summary.status).toBe("active");
    expect(summary.warningLevel).toBe("info");
  });

  it("marks schedules near end date as expiring", () => {
    const summary = summarizeRewardScheduleHealth(
      {
        ...baseSchedule,
        endDate: new Date("2026-06-02T00:00:00Z"),
      },
      { now, expiringWithinDays: 7 },
    );
    expect(summary.status).toBe("expiring");
    expect(summary.warningLevel).toBe("warning");
  });

  it("marks expired schedules as critical", () => {
    const summary = summarizeRewardScheduleHealth(
      {
        ...baseSchedule,
        endDate: new Date("2026-05-20T00:00:00Z"),
      },
      { now },
    );
    expect(summary.status).toBe("expired");
    expect(summary.warningLevel).toBe("critical");
  });

  it("marks inactive schedules even if end date is in the future", () => {
    const summary = summarizeRewardScheduleHealth(
      {
        ...baseSchedule,
        isActive: false,
      },
      { now },
    );
    expect(summary.status).toBe("inactive");
    expect(summary.warningLevel).toBe("warning");
  });

  it("marks active schedules with no recent claims as critical expiring", () => {
    const summary = summarizeRewardScheduleHealth(
      {
        ...baseSchedule,
        endDate: new Date("2026-06-01T00:00:00Z"),
        lastClaimAt: new Date("2026-04-01T00:00:00Z"),
      },
      { now, expiringWithinDays: 14, inactiveClaimWindowDays: 14 },
    );
    expect(summary.status).toBe("expiring");
    expect(summary.warningLevel).toBe("critical");
    expect(summary.hasRecentClaims).toBe(false);
  });
});

// ── wallClockToUtc / renderInTimeZone (#965) ───────────────────────────────

describe("wallClockToUtc", () => {
  it("converts a New York wall clock during EDT (summer, UTC-4)", () => {
    const utc = wallClockToUtc({
      wallClock: { year: 2026, month: 7, day: 15, hour: 12, minute: 0 },
      timeZone: "America/New_York",
    });
    expect(utc.toISOString()).toBe("2026-07-15T16:00:00.000Z");
  });

  it("converts a New York wall clock during EST (winter, UTC-5)", () => {
    const utc = wallClockToUtc({
      wallClock: { year: 2026, month: 1, day: 15, hour: 12, minute: 0 },
      timeZone: "America/New_York",
    });
    expect(utc.toISOString()).toBe("2026-01-15T17:00:00.000Z");
  });

  it("correctly resolves wall clocks either side of the spring-forward transition", () => {
    // 2026-03-08 is the US spring-forward date for America/New_York.
    const beforeTransition = wallClockToUtc({
      wallClock: { year: 2026, month: 3, day: 8, hour: 1, minute: 30 },
      timeZone: "America/New_York",
    });
    const afterTransition = wallClockToUtc({
      wallClock: { year: 2026, month: 3, day: 8, hour: 3, minute: 30 },
      timeZone: "America/New_York",
    });
    expect(beforeTransition.toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(afterTransition.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("is a round trip with renderInTimeZone across a DST boundary", () => {
    const summerUtc = wallClockToUtc({
      wallClock: { year: 2026, month: 7, day: 15, hour: 9, minute: 0 },
      timeZone: "America/New_York",
    });
    const winterUtc = wallClockToUtc({
      wallClock: { year: 2026, month: 1, day: 15, hour: 9, minute: 0 },
      timeZone: "America/New_York",
    });

    const summerLocal = renderInTimeZone(summerUtc, "America/New_York");
    const winterLocal = renderInTimeZone(winterUtc, "America/New_York");

    expect(summerLocal.utcOffsetMinutes).toBe(-240); // EDT
    expect(winterLocal.utcOffsetMinutes).toBe(-300); // EST
    expect(summerLocal.isoLocal).toBe("2026-07-15T09:00:00-04:00");
    expect(winterLocal.isoLocal).toBe("2026-01-15T09:00:00-05:00");
  });
});

describe("renderInTimeZone", () => {
  it("does not mutate the stored UTC instant it renders", () => {
    const stored = new Date("2026-05-04T13:00:00.000Z");
    const before = stored.getTime();
    renderInTimeZone(stored, "Asia/Tokyo");
    expect(stored.getTime()).toBe(before);
  });

  it("renders the same UTC instant differently across timezones", () => {
    const stored = new Date("2026-05-04T13:00:00.000Z");
    const tokyo = renderInTimeZone(stored, "Asia/Tokyo");
    const london = renderInTimeZone(stored, "Europe/London");
    const newYork = renderInTimeZone(stored, "America/New_York");

    expect(tokyo.isoLocal).toBe("2026-05-04T22:00:00+09:00");
    expect(london.isoLocal).toBe("2026-05-04T14:00:00+01:00");
    expect(newYork.isoLocal).toBe("2026-05-04T09:00:00-04:00");
  });
});

// ── normalizeScheduleWindowToUtc (#965) ─────────────────────────────────────

describe("normalizeScheduleWindowToUtc", () => {
  it("passes already-UTC Date windows through unchanged", () => {
    const start = new Date("2026-05-01T00:00:00Z");
    const end = new Date("2026-05-08T00:00:00Z");
    const normalized = normalizeScheduleWindowToUtc({ start, end });
    expect(normalized.startDate.getTime()).toBe(start.getTime());
    expect(normalized.endDate.getTime()).toBe(end.getTime());
  });

  it("normalizes a wall-clock authored window to UTC", () => {
    const normalized = normalizeScheduleWindowToUtc({
      start: {
        wallClock: { year: 2026, month: 5, day: 4, hour: 0, minute: 0 },
        timeZone: "America/New_York",
      },
      end: {
        wallClock: { year: 2026, month: 5, day: 11, hour: 0, minute: 0 },
        timeZone: "America/New_York",
      },
    });
    expect(normalized.startDate.toISOString()).toBe("2026-05-04T04:00:00.000Z");
    expect(normalized.endDate.toISOString()).toBe("2026-05-11T04:00:00.000Z");
  });

  it("supports mixing a UTC Date and a wall-clock endpoint", () => {
    const normalized = normalizeScheduleWindowToUtc({
      start: new Date("2026-05-01T00:00:00Z"),
      end: {
        wallClock: { year: 2026, month: 5, day: 8, hour: 0, minute: 0 },
        timeZone: "America/New_York",
      },
    });
    expect(normalized.startDate.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(normalized.endDate.toISOString()).toBe("2026-05-08T04:00:00.000Z");
  });

  it("throws when the normalized window is inverted", () => {
    expect(() =>
      normalizeScheduleWindowToUtc({
        start: new Date("2026-05-08T00:00:00Z"),
        end: new Date("2026-05-01T00:00:00Z"),
      }),
    ).toThrow(/end must be strictly after start/i);
  });

  it("throws when the normalized window has zero duration (exact boundary)", () => {
    const sameInstant = new Date("2026-05-01T00:00:00Z");
    expect(() =>
      normalizeScheduleWindowToUtc({ start: sameInstant, end: new Date(sameInstant) }),
    ).toThrow(/end must be strictly after start/i);
  });
});

// ── ISO week (UTC) helpers: week rollover and boundary moments (#965) ──────

describe("startOfIsoWeekUtc / endOfIsoWeekUtc / isSameIsoWeekUtc", () => {
  it("returns the same instant when given exactly the Monday 00:00:00.000 UTC boundary", () => {
    const monday = new Date("2026-05-04T00:00:00.000Z"); // a Monday
    expect(startOfIsoWeekUtc(monday).getTime()).toBe(monday.getTime());
  });

  it("rolls a mid-week instant back to the preceding Monday", () => {
    const wednesday = new Date("2026-05-06T15:30:00.000Z");
    expect(startOfIsoWeekUtc(wednesday).toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });

  it("rolls a Sunday instant back to the Monday that started its week", () => {
    const sundayNight = new Date("2026-05-10T23:59:59.999Z");
    expect(startOfIsoWeekUtc(sundayNight).toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });

  it("computes an exclusive week end that equals the next week's start", () => {
    const monday = new Date("2026-05-04T00:00:00.000Z");
    const nextMonday = new Date("2026-05-11T00:00:00.000Z");
    expect(endOfIsoWeekUtc(monday).getTime()).toBe(nextMonday.getTime());
    expect(startOfIsoWeekUtc(nextMonday).getTime()).toBe(nextMonday.getTime());
  });

  it("treats the last millisecond of a week and the first millisecond of the next as different weeks", () => {
    const lastMsOfWeek = new Date("2026-05-10T23:59:59.999Z");
    const firstMsOfNextWeek = new Date("2026-05-11T00:00:00.000Z");
    expect(isSameIsoWeekUtc(lastMsOfWeek, firstMsOfNextWeek)).toBe(false);
  });

  it("treats two instants on different days of the same week as the same week", () => {
    const mondayMorning = new Date("2026-05-04T02:00:00.000Z");
    const sundayNight = new Date("2026-05-10T22:00:00.000Z");
    expect(isSameIsoWeekUtc(mondayMorning, sundayNight)).toBe(true);
  });

  it("handles week rollover across a month boundary", () => {
    // 2026-06-01 is a Monday.
    const lastDayOfMay = new Date("2026-05-31T12:00:00.000Z");
    expect(startOfIsoWeekUtc(lastDayOfMay).toISOString()).toBe("2026-05-25T00:00:00.000Z");
    expect(isSameIsoWeekUtc(lastDayOfMay, new Date("2026-05-25T00:00:00.000Z"))).toBe(true);
    expect(isSameIsoWeekUtc(lastDayOfMay, new Date("2026-06-01T00:00:00.000Z"))).toBe(false);
  });
});

