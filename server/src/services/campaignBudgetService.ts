/**
 * Reward campaign budget exhaustion warnings (#1160).
 *
 * Estimates remaining runway for a reward campaign's claim budget based on
 * recent claim velocity, so admins get a warning before the budget actually
 * runs out rather than discovering it once claims start failing.
 */

export type CampaignBudgetStatus = "healthy" | "low" | "depleted";

export interface CampaignClaim {
  amount: number;
  /** ISO 8601 timestamp the claim was made. */
  claimedAt: string;
}

export interface RewardCampaignBudget {
  campaignId: string;
  totalBudget: number;
  claims: CampaignClaim[];
}

export interface CampaignBudgetWarning {
  status: CampaignBudgetStatus;
  remainingBudget: number;
  claimedToDate: number;
  /**
   * Estimated days of coverage left at recent claim velocity, or `null` when
   * there isn't enough recent claim history to produce a non-misleading
   * estimate (e.g. no claims at all yet).
   */
  estimatedDaysRemaining: number | null;
  message: string;
}

/** Remaining budget at or below this fraction of total is flagged "low". */
const LOW_BUDGET_THRESHOLD_PCT = 0.15;
/** Claim velocity is measured over this trailing window. */
const VELOCITY_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function evaluateCampaignBudget(
  campaign: RewardCampaignBudget,
  now: Date = new Date(),
): CampaignBudgetWarning {
  const claimedToDate = campaign.claims.reduce((sum, c) => sum + c.amount, 0);

  if (campaign.totalBudget <= 0) {
    return {
      status: "depleted",
      remainingBudget: 0,
      claimedToDate,
      estimatedDaysRemaining: 0,
      message: `Campaign "${campaign.campaignId}" has no allocated budget.`,
    };
  }

  const remainingBudget = Math.max(
    Math.round((campaign.totalBudget - claimedToDate) * 100) / 100,
    0,
  );

  const windowStart = new Date(now.getTime() - VELOCITY_WINDOW_DAYS * MS_PER_DAY);
  const recentTotal = campaign.claims
    .filter((c) => {
      const claimedAt = new Date(c.claimedAt);
      return claimedAt >= windowStart && claimedAt <= now;
    })
    .reduce((sum, c) => sum + c.amount, 0);
  const dailyVelocity = recentTotal / VELOCITY_WINDOW_DAYS;

  // No claims yet, or no claim activity in the recent window: don't project
  // a coverage estimate from zero data, since that would be misleading.
  const estimatedDaysRemaining =
    campaign.claims.length === 0 || dailyVelocity <= 0
      ? null
      : Math.round((remainingBudget / dailyVelocity) * 100) / 100;

  let status: CampaignBudgetStatus;
  if (remainingBudget <= 0) {
    status = "depleted";
  } else if (remainingBudget / campaign.totalBudget <= LOW_BUDGET_THRESHOLD_PCT) {
    status = "low";
  } else {
    status = "healthy";
  }

  let message: string;
  if (status === "depleted") {
    message = `Campaign "${campaign.campaignId}" budget is fully depleted.`;
  } else if (status === "low") {
    message =
      estimatedDaysRemaining !== null
        ? `Campaign "${campaign.campaignId}" has ${remainingBudget.toFixed(2)} remaining, covering roughly ${estimatedDaysRemaining} more day(s) at the current claim rate.`
        : `Campaign "${campaign.campaignId}" has ${remainingBudget.toFixed(2)} remaining and no recent claim activity to estimate coverage from.`;
  } else {
    message = `Campaign "${campaign.campaignId}" budget is healthy.`;
  }

  return { status, remainingBudget, claimedToDate, estimatedDaysRemaining, message };
}
