import { summarizeRewardScheduleHealth, type RewardScheduleMonitorInput } from "../scheduleHealth";

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

