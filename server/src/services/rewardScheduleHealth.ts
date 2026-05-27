export type RewardScheduleStatus =
  | "active"
  | "expiring"
  | "expired"
  | "inactive";

export type RewardScheduleWarningLevel = "info" | "warning" | "critical";

export interface RewardScheduleMonitorInput {
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
