import { RewardScheduleModel } from "../models/RewardSchedule";
import { RewardSchedule, RewardEventType } from "../types/rewards";

export class RewardScheduleRegistry {
  /**
   * Registers or updates a reward schedule.
   * Unknown or incomplete schedules are marked as low confidence by default.
   */
  static async registerSchedule(schedule: Partial<RewardSchedule> & { 
    protocolName: string; 
    tokenSymbol: string; 
    sourceProvenance: string;
    dailyEmission: number;
    startDate: Date;
    endDate: Date;
  }): Promise<RewardSchedule> {
    const existing = await RewardScheduleModel.findOne({
      protocolName: schedule.protocolName,
      tokenSymbol: schedule.tokenSymbol,
      isActive: true
    });

    if (existing) {
      Object.assign(existing, schedule);
      return await existing.save();
    }

    const newSchedule = new RewardScheduleModel({
      ...schedule,
      confidence: schedule.confidence || "low",
      events: schedule.events || [
        { type: 'START', date: schedule.startDate },
        { type: 'END', date: schedule.endDate }
      ]
    });

    return await newSchedule.save();
  }

  /**
   * Retrieves all active schedules for a protocol.
   */
  static async getActiveSchedules(protocolName: string, date: Date = new Date()): Promise<RewardSchedule[]> {
    return await RewardScheduleModel.find({
      protocolName,
      isActive: true,
      startDate: { $lte: date },
      endDate: { $gte: date }
    }).lean();
  }

  /**
   * Calculates the projected emission rate for a specific date.
   * Handles cliffs and tapering logic.
   */
  static calculateEmissionAt(schedule: RewardSchedule, date: Date): number {
    if (date < schedule.startDate || date > schedule.endDate) {
      return 0;
    }

    // Handle Cliff
    if (schedule.cliffDate && date < schedule.cliffDate) {
      return 0;
    }

    let emission = schedule.dailyEmission;

    // Handle Tapering
    if (schedule.taperStartDate && date >= schedule.taperStartDate) {
      const taperEnd = schedule.taperEndDate || schedule.endDate;
      if (date >= taperEnd) {
        return 0;
      }

      const totalTaperDays = Math.max(1, (taperEnd.getTime() - schedule.taperStartDate.getTime()) / (1000 * 60 * 60 * 24));
      const elapsedTaperDays = (date.getTime() - schedule.taperStartDate.getTime()) / (1000 * 60 * 60 * 24);
      
      const taperProgress = elapsedTaperDays / totalTaperDays;
      
      // Linear tapering
      emission = emission * (1 - taperProgress);
    }

    return emission;
  }

  /**
   * Checks if a schedule has expired and updates its isActive status.
   */
  static async cleanupExpiredSchedules(date: Date = new Date()): Promise<number> {
    const result = await RewardScheduleModel.updateMany(
      { endDate: { $lt: date }, isActive: true },
      { $set: { isActive: false } }
    );
    return result.modifiedCount;
  }

  /**
   * Estimates the reward APY contribution for a protocol at a future date.
   * Only uses high/medium confidence schedules for "high-confidence" projections.
   */
  static async estimateRewardApy(
    protocolName: string, 
    date: Date, 
    tokenPrice: number, 
    protocolTvl: number,
    minConfidence: "low" | "medium" | "high" = "low"
  ): Promise<number> {
    const schedules = await RewardScheduleModel.find({
      protocolName,
      isActive: true,
      startDate: { $lte: date },
      endDate: { $gte: date },
      confidence: { $in: this.getConfidenceLevels(minConfidence) }
    });

    let totalYearlyValue = 0;
    for (const schedule of schedules) {
      const dailyEmission = this.calculateEmissionAt(schedule, date);
      totalYearlyValue += dailyEmission * 365 * tokenPrice;
    }

    if (protocolTvl <= 0) return 0;

    return (totalYearlyValue / protocolTvl) * 100;
  }

  private static getConfidenceLevels(min: string): string[] {
    if (min === "high") return ["high"];
    if (min === "medium") return ["high", "medium"];
    return ["high", "medium", "low"];
  }
}
