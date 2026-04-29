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
  });
});
