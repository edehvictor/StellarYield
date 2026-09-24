import { RewardScheduleModel } from "../models/RewardSchedule";
import { RewardSchedule } from "../types/rewards";
import {
  summarizeRewardScheduleHealth,
  type RewardScheduleHealthSummary,
  type RewardScheduleMonitorInput,
} from "./rewardScheduleHealth";

/** Error code carried by {@link RewardScheduleOverlapError}. */
export type RewardScheduleOverlapErrorCode = "reward_schedule_overlap";

/** Minimal shape needed to compare two schedule windows for overlap. */
export interface RewardScheduleWindow {
  protocolName: string;
  tokenSymbol: string;
  startDate: Date;
  endDate: Date;
}

/**
 * Typed error raised when publishing a reward schedule would overlap an
 * existing active schedule window for the same protocol + token.
 */
export class RewardScheduleOverlapError extends Error {
  constructor(
    public readonly code: RewardScheduleOverlapErrorCode,
    /** The schedule being published. */
    public readonly candidate: RewardScheduleWindow,
    /** The existing active schedule it conflicts with. */
    public readonly conflictsWith: RewardScheduleWindow,
  ) {
    super(
      `Reward schedule overlap for ${candidate.protocolName}/${candidate.tokenSymbol}: ` +
        `window [${candidate.startDate.toISOString()}, ${candidate.endDate.toISOString()}] overlaps ` +
        `existing active window [${conflictsWith.startDate.toISOString()}, ${conflictsWith.endDate.toISOString()}]. ` +
        `Publishing is blocked until the conflict is resolved.`,
    );
    this.name = "RewardScheduleOverlapError";
  }
}

/**
 * Determines whether two reward schedule windows overlap.
 *
 * Windows are treated as half-open intervals `[startDate, endDate)` for the
 * purpose of conflict detection: two windows that merely touch at a shared
 * boundary point (e.g. `[1, 10]` and `[10, 20]`) are NOT considered a
 * conflict, since the first window's eligibility ends exactly when the
 * second begins and there is no instant where both are simultaneously
 * eligible. Any real overlap of the ranges (including one window fully
 * nested inside another) IS a conflict.
 *
 * This mirrors `calculateEmissionAt`'s inclusive `endDate` for emission
 * purposes while keeping publish-time conflict detection strict, so
 * back-to-back campaigns can still be scheduled without a gap.
 */
export function schedulesOverlap(a: RewardScheduleWindow, b: RewardScheduleWindow): boolean {
  const aStart = a.startDate.getTime();
  const aEnd = a.endDate.getTime();
  const bStart = b.startDate.getTime();
  const bEnd = b.endDate.getTime();

  return aStart < bEnd && bStart < aEnd;
}

/**
 * Finds the first existing active schedule (same protocol + token) whose
 * window overlaps the candidate window, or `undefined` if there is no
 * conflict.
 */
export function findOverlappingSchedule(
  candidate: RewardScheduleWindow,
  existingSchedules: RewardScheduleWindow[],
): RewardScheduleWindow | undefined {
  return existingSchedules.find(
    (existing) =>
      existing.protocolName === candidate.protocolName &&
      existing.tokenSymbol === candidate.tokenSymbol &&
      schedulesOverlap(candidate, existing),
  );
}

export class RewardScheduleRegistry {
  /**
   * Registers or updates a reward schedule.
   * Unknown or incomplete schedules are marked as low confidence by default.
   *
   * Before publishing (creating, or updating the window of, an active
   * schedule), the candidate window is checked against other active
   * schedules for the same protocol + token. Overlapping windows are
   * rejected with a {@link RewardScheduleOverlapError} so duplicate
   * eligibility windows and confusing claim behavior can't reach
   * publication. Windows that only touch at a shared boundary point are
   * allowed — see {@link schedulesOverlap} for the exact rule.
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

    const otherActiveScheduleDocs = await RewardScheduleModel.find({
      protocolName: schedule.protocolName,
      tokenSymbol: schedule.tokenSymbol,
      isActive: true,
      ...(existing ? { _id: { $ne: existing._id } } : {}),
    }).lean();

    const otherActiveSchedules: RewardScheduleWindow[] = (otherActiveScheduleDocs || []).map((doc: any) => ({
      protocolName: doc.protocolName,
      tokenSymbol: doc.tokenSymbol,
      startDate: new Date(doc.startDate),
      endDate: new Date(doc.endDate),
    }));

    const conflict = findOverlappingSchedule(
      {
        protocolName: schedule.protocolName,
        tokenSymbol: schedule.tokenSymbol,
        startDate: schedule.startDate,
        endDate: schedule.endDate,
      },
      otherActiveSchedules,
    );

    if (conflict) {
      throw new RewardScheduleOverlapError(
        "reward_schedule_overlap",
        {
          protocolName: schedule.protocolName,
          tokenSymbol: schedule.tokenSymbol,
          startDate: schedule.startDate,
          endDate: schedule.endDate,
        },
        conflict,
      );
    }

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
    try {
      const mongoose = require("mongoose");
      const isMocked = typeof (RewardScheduleModel.find as any).mock !== "undefined";
      if (!isMocked && (!mongoose.connection || mongoose.connection.readyState !== 1)) {
        return [];
      }
      return await RewardScheduleModel.find({
        protocolName,
        isActive: true,
        startDate: { $lte: date },
        endDate: { $gte: date }
      }).lean();
    } catch {
      return [];
    }
  }

  /**
   * Calculates the projected emission rate for a specific date.
   * Handles cliffs and tapering logic.
   */
  static calculateEmissionAt(schedule: Partial<RewardSchedule>, date: Date): number {
    if (!schedule.startDate || !schedule.endDate || !schedule.dailyEmission) {
      return 0;
    }

    const targetTime = date.getTime();
    const startTime = new Date(schedule.startDate).getTime();
    const endTime = new Date(schedule.endDate).getTime();

    if (targetTime < startTime || targetTime > endTime) {
      return 0;
    }

    if (schedule.cliffDate && targetTime < new Date(schedule.cliffDate).getTime()) {
      return 0;
    }

    let emission = schedule.dailyEmission;

    if (schedule.taperStartDate && schedule.taperEndDate) {
      const taperStart = new Date(schedule.taperStartDate).getTime();
      const taperEnd = new Date(schedule.taperEndDate).getTime();
      if (targetTime >= taperStart) {
        if (targetTime >= taperEnd) {
          return 0;
        }
        const progress = (targetTime - taperStart) / (taperEnd - taperStart);
        emission = emission * (1 - progress);
      }
    }

    return emission;
  }

  /**
   * Disables all active schedules for a protocol.
   * Useful for emergency pause or migration.
   */
  static async deactivateProtocolSchedules(protocolName: string): Promise<number> {
    const result = await RewardScheduleModel.updateMany(
      { protocolName, isActive: true },
      { $set: { isActive: false } }
    );
    return result.modifiedCount;
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

  static summarizeSchedulesForMaintainers(
    schedules: RewardScheduleMonitorInput[],
    date: Date = new Date()
  ): RewardScheduleHealthSummary[] {
    return schedules
      .map((schedule) => summarizeRewardScheduleHealth(schedule, { now: date }))
      .sort((left, right) => left.daysUntilEnd - right.daysUntilEnd);
  }

  static async getMaintainerScheduleRaw(date: Date = new Date()): Promise<RewardScheduleMonitorInput[]> {
    try {
      const mongoose = require("mongoose");
      const isMocked = typeof (RewardScheduleModel.find as any).mock !== "undefined";
      if (!isMocked && (!mongoose.connection || mongoose.connection.readyState !== 1)) {
        return [];
      }
      const schedules = await RewardScheduleModel.find({}).lean();
      return schedules as RewardScheduleMonitorInput[];
    } catch {
      return [];
    }
  }

  static async getMaintainerScheduleSummary(
    date: Date = new Date()
  ): Promise<RewardScheduleHealthSummary[]> {
    const schedules = await this.getMaintainerScheduleRaw(date);
    return this.summarizeSchedulesForMaintainers(schedules, date);
  }

  private static getConfidenceLevels(min: string): string[] {
    if (min === "high") return ["high"];
    if (min === "medium") return ["high", "medium"];
    return ["high", "medium", "low"];
  }
}
