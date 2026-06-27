import { RewardScheduleRegistry } from "../rewardScheduleRegistry";
import { RewardSchedule } from "../../types/rewards";
import { RewardScheduleModel } from "../../models/RewardSchedule";

jest.mock("../../models/RewardSchedule", () => ({
  RewardScheduleModel: {
    findOne: jest.fn(),
    find: jest.fn(),
    updateMany: jest.fn(),
    prototype: {
      save: jest.fn()
    }
  }
}));

describe("RewardScheduleRegistry", () => {
  describe("calculateEmissionAt", () => {
    const baseSchedule: RewardSchedule = {
      protocolName: "TestProtocol",
      tokenSymbol: "TEST",
      dailyEmission: 100,
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-12-31T00:00:00Z"),
      sourceProvenance: "Test source",
      confidence: "high",
      isActive: true,
      events: []
    };

    it("returns 0 before start date", () => {
      const emission = RewardScheduleRegistry.calculateEmissionAt(baseSchedule, new Date("2025-12-31T23:59:59Z"));
      expect(emission).toBe(0);
    });

    it("returns 0 after end date", () => {
      const emission = RewardScheduleRegistry.calculateEmissionAt(baseSchedule, new Date("2027-01-01T00:00:01Z"));
      expect(emission).toBe(0);
    });

    it("returns dailyEmission during active period", () => {
      const emission = RewardScheduleRegistry.calculateEmissionAt(baseSchedule, new Date("2026-06-01T00:00:00Z"));
      expect(emission).toBe(100);
    });

    it("returns 0 during cliff period", () => {
      const cliffSchedule = { ...baseSchedule, cliffDate: new Date("2026-02-01T00:00:00Z") };
      const emission = RewardScheduleRegistry.calculateEmissionAt(cliffSchedule, new Date("2026-01-15T00:00:00Z"));
      expect(emission).toBe(0);
    });

    it("returns dailyEmission after cliff period", () => {
      const cliffSchedule = { ...baseSchedule, cliffDate: new Date("2026-02-01T00:00:00Z") };
      const emission = RewardScheduleRegistry.calculateEmissionAt(cliffSchedule, new Date("2026-02-15T00:00:00Z"));
      expect(emission).toBe(100);
    });

    it("handles tapering correctly", () => {
      const taperSchedule = {
        ...baseSchedule,
        taperStartDate: new Date("2026-10-01T00:00:00Z"),
        taperEndDate: new Date("2026-12-31T00:00:00Z")
      };
      
      // Start of tapering
      expect(RewardScheduleRegistry.calculateEmissionAt(taperSchedule, new Date("2026-10-01T00:00:00Z"))).toBe(100);
      
      // Middle of tapering (approx 50%)
      const middleDate = new Date("2026-11-15T12:00:00Z");
      const emission = RewardScheduleRegistry.calculateEmissionAt(taperSchedule, middleDate);
      expect(emission).toBeLessThan(100);
      expect(emission).toBeGreaterThan(0);
      expect(emission).toBeCloseTo(50, 0);
      
      // End of tapering
      expect(RewardScheduleRegistry.calculateEmissionAt(taperSchedule, new Date("2026-12-31T00:00:00Z"))).toBe(0);
    });
  });

  describe("DB interactions", () => {
    it("cleanupExpiredSchedules updates records", async () => {
      const mockUpdateMany = RewardScheduleModel.updateMany as jest.Mock;
      mockUpdateMany.mockResolvedValue({ modifiedCount: 5 });

      const result = await RewardScheduleRegistry.cleanupExpiredSchedules(new Date());
      expect(result).toBe(5);
      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ endDate: { $lt: expect.any(Date) }, isActive: true }),
        expect.objectContaining({ $set: { isActive: false } })
      );
    });

    it("getActiveSchedules queries correctly", async () => {
      const mockFind = RewardScheduleModel.find as jest.Mock;
      mockFind.mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ protocolName: "Test" }])
      });

      const result = await RewardScheduleRegistry.getActiveSchedules("Test");
      expect(result).toHaveLength(1);
      expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({
        protocolName: "Test",
        isActive: true
      }));
    });

    it("summarizeSchedulesForMaintainers marks mixed schedule health states", () => {
      const base = {
        protocolName: "TestProtocol",
        tokenSymbol: "TEST",
        dailyEmission: 100,
        startDate: new Date("2026-01-01T00:00:00Z"),
        sourceProvenance: "Test source",
        confidence: "high" as const,
        events: [],
      };

      const summaries = RewardScheduleRegistry.summarizeSchedulesForMaintainers(
        [
          {
            ...base,
            isActive: true,
            endDate: new Date("2026-07-01T00:00:00Z"),
            lastClaimAt: new Date("2026-05-26T00:00:00Z"),
          },
          {
            ...base,
            isActive: true,
            endDate: new Date("2026-05-30T00:00:00Z"),
            lastClaimAt: new Date("2026-05-20T00:00:00Z"),
          },
          {
            ...base,
            isActive: true,
            endDate: new Date("2026-05-01T00:00:00Z"),
            lastClaimAt: new Date("2026-04-01T00:00:00Z"),
          },
          {
            ...base,
            isActive: false,
            endDate: new Date("2026-07-01T00:00:00Z"),
            lastClaimAt: new Date("2026-05-26T00:00:00Z"),
          },
        ],
        new Date("2026-05-27T00:00:00Z"),
      );

      expect(summaries.map((summary) => summary.status)).toEqual(
        expect.arrayContaining(["active", "expiring", "expired", "inactive"]),
      );
    });
  });

  describe("timezone and date rollover behavior", () => {
    const timezoneSchedule: RewardSchedule = {
      protocolName: "TZProtocol",
      tokenSymbol: "TZT",
      dailyEmission: 50,
      startDate: new Date("2026-06-01T00:00:00Z"),
      endDate: new Date("2026-06-30T23:59:59Z"),
      sourceProvenance: "Test source",
      confidence: "medium",
      isActive: true,
      events: []
    };

    it("handles transition at exactly midnight UTC", () => {
      // 1 millisecond before start
      expect(RewardScheduleRegistry.calculateEmissionAt(timezoneSchedule, new Date("2026-05-31T23:59:59.999Z"))).toBe(0);
      // Exactly start
      expect(RewardScheduleRegistry.calculateEmissionAt(timezoneSchedule, new Date("2026-06-01T00:00:00.000Z"))).toBe(50);
      // Exactly end
      expect(RewardScheduleRegistry.calculateEmissionAt(timezoneSchedule, new Date("2026-06-30T23:59:59.000Z"))).toBe(50);
      // 1 second after end
      expect(RewardScheduleRegistry.calculateEmissionAt(timezoneSchedule, new Date("2026-07-01T00:00:00.000Z"))).toBe(0);
    });

    it("handles month-boundary transition (February to March in Leap and Non-Leap years)", () => {
      const nonLeapFebSchedule: RewardSchedule = {
        ...timezoneSchedule,
        startDate: new Date("2026-02-01T00:00:00Z"),
        endDate: new Date("2026-02-28T23:59:59Z")
      };

      // Non-leap year 2026
      expect(RewardScheduleRegistry.calculateEmissionAt(nonLeapFebSchedule, new Date("2026-02-28T23:59:59.000Z"))).toBe(50);
      expect(RewardScheduleRegistry.calculateEmissionAt(nonLeapFebSchedule, new Date("2026-03-01T00:00:00.000Z"))).toBe(0);

      // Leap year 2028
      const leapFebSchedule: RewardSchedule = {
        ...timezoneSchedule,
        startDate: new Date("2028-02-01T00:00:00Z"),
        endDate: new Date("2028-02-29T23:59:59Z")
      };

      expect(RewardScheduleRegistry.calculateEmissionAt(leapFebSchedule, new Date("2028-02-28T23:59:59.000Z"))).toBe(50);
      expect(RewardScheduleRegistry.calculateEmissionAt(leapFebSchedule, new Date("2028-02-29T23:59:59.000Z"))).toBe(50);
      expect(RewardScheduleRegistry.calculateEmissionAt(leapFebSchedule, new Date("2028-03-01T00:00:00.000Z"))).toBe(0);
    });

    it("processes timezone-sensitive date handling with offsets", () => {
      // 2026-06-01T00:00:00Z is equivalent to 2026-05-31T20:00:00-04:00 (EDT)
      const inputEDTBefore = new Date("2026-05-31T19:59:59-04:00"); // before start in UTC
      const inputEDTActive = new Date("2026-05-31T20:00:00-04:00"); // exactly start in UTC

      expect(RewardScheduleRegistry.calculateEmissionAt(timezoneSchedule, inputEDTBefore)).toBe(0);
      expect(RewardScheduleRegistry.calculateEmissionAt(timezoneSchedule, inputEDTActive)).toBe(50);

      // 2026-06-30T23:59:59Z is equivalent to 2026-07-01T09:59:59+10:00 (AEST)
      const inputAESTActive = new Date("2026-07-01T09:59:59+10:00"); // exactly end in UTC
      const inputAESTAfter = new Date("2026-07-01T10:00:00+10:00"); // after end in UTC

      expect(RewardScheduleRegistry.calculateEmissionAt(timezoneSchedule, inputAESTActive)).toBe(50);
      expect(RewardScheduleRegistry.calculateEmissionAt(timezoneSchedule, inputAESTAfter)).toBe(0);
    });

    it("validates schedule health summaries at boundary timestamps", () => {
      const mockMonitorInput = {
        protocolName: "TZProtocol",
        tokenSymbol: "TZT",
        dailyEmission: 50,
        startDate: new Date("2026-06-01T00:00:00Z"),
        endDate: new Date("2026-06-30T23:59:59Z"),
        sourceProvenance: "Test source",
        confidence: "medium" as const,
        isActive: true,
        events: [],
        lastClaimAt: new Date("2026-06-25T00:00:00Z")
      };

      // 1 ms before expiration (2026-06-30T23:59:58.999Z) -> should be expiring
      const expiringTime = new Date("2026-06-30T23:59:58.999Z");
      const expiringSummary = RewardScheduleRegistry.summarizeSchedulesForMaintainers([mockMonitorInput], expiringTime)[0];
      expect(expiringSummary.status).toBe("expiring");

      // Exactly at expiration (2026-06-30T23:59:59.000Z) -> is NOT expired yet (it is inclusive boundary or < comparison depending on implementation)
      // Wait, summarizeRewardScheduleHealth has: `if (schedule.endDate.getTime() < now.getTime()) { status: "expired" }`
      // So at exactly endDate, end.getTime() < now.getTime() is false. So it is still "expiring".
      const exactEndTime = new Date("2026-06-30T23:59:59.000Z");
      const exactEndSummary = RewardScheduleRegistry.summarizeSchedulesForMaintainers([mockMonitorInput], exactEndTime)[0];
      expect(exactEndSummary.status).toBe("expiring");

      // 1 ms after expiration -> expired
      const expiredTime = new Date("2026-06-30T23:59:59.001Z");
      const expiredSummary = RewardScheduleRegistry.summarizeSchedulesForMaintainers([mockMonitorInput], expiredTime)[0];
      expect(expiredSummary.status).toBe("expired");
      expect(expiredSummary.warningLevel).toBe("critical");
    });
  });
});

