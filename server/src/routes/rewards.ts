import { Router, Request, Response } from "express";
import {
  evaluateCampaignBudget,
  type RewardCampaignBudget,
} from "../services/campaignBudgetService";
import { RewardScheduleRegistry } from "../services/rewardScheduleRegistry";
import {
  summarizeRewardScheduleHealth,
  type RewardScheduleHealthSummary,
  type RewardScheduleMonitorInput,
} from "../services/rewardScheduleHealth";

const router = Router();

/** Validate unclaimed campaign liability against its funded reserve. */
router.post("/campaign-budget/preview", (req: Request, res: Response) => {
  const body = req.body as Partial<RewardCampaignBudget> | null;
  if (
    !body ||
    typeof body.campaignId !== "string" ||
    !body.campaignId.trim() ||
    typeof body.totalBudget !== "number" ||
    !Number.isFinite(body.totalBudget) ||
    body.totalBudget < 0 ||
    !Array.isArray(body.claims)
  ) {
    res.status(400).json({ error: "Provide a campaignId, non-negative totalBudget, and claims array." });
    return;
  }

  if (
    body.fundedReserve !== undefined &&
    (typeof body.fundedReserve !== "number" || !Number.isFinite(body.fundedReserve) || body.fundedReserve < 0)
  ) {
    res.status(400).json({ error: "fundedReserve must be a non-negative finite number." });
    return;
  }

  if (body.claims.some((claim) =>
    !claim ||
    typeof claim.amount !== "number" ||
    !Number.isFinite(claim.amount) ||
    claim.amount < 0 ||
    typeof claim.claimedAt !== "string" ||
    !Number.isFinite(Date.parse(claim.claimedAt))
  )) {
    res.status(400).json({ error: "Every claim must have a non-negative amount and valid claimedAt timestamp." });
    return;
  }

  const campaign: RewardCampaignBudget = {
    campaignId: body.campaignId,
    totalBudget: body.totalBudget,
    claims: body.claims,
    ...(body.fundedReserve === undefined ? {} : { fundedReserve: body.fundedReserve }),
  };
  res.json(evaluateCampaignBudget(campaign));
});

router.get("/schedule-summary", async (_req: Request, res: Response) => {
  try {
    const schedules = await RewardScheduleRegistry.getMaintainerScheduleSummary();
    res.json({
      generatedAt: new Date().toISOString(),
      schedules,
    });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to summarize reward schedules",
    });
  }
});

/**
 * Dry-run preview of reward schedule health and payout timing.
 *
 * GET /api/rewards/dry-run
 *
 * Returns maintainer-facing health summaries and payout timing risk without mutating state.
 * Query params:
 *  - now (ISO date, optional): override the reference date for the preview
 */
router.get("/dry-run", async (req: Request, res: Response) => {
  try {
    const referenceDate = req.query.now
      ? new Date(req.query.now as string)
      : new Date();

    if (Number.isNaN(referenceDate.getTime())) {
      res.status(400).json({
        error: "Invalid 'now' query parameter. Provide an ISO date string.",
        code: "invalid_query",
      });
      return;
    }

    const schedules = await RewardScheduleRegistry.getMaintainerScheduleSummary(
      referenceDate,
    );

    const health = schedules.map((entry) => {
      const scheduleInput: RewardScheduleMonitorInput = {
        protocolName: entry.protocolName,
        tokenSymbol: entry.tokenSymbol,
        dailyEmission: entry.dailyEmission,
        startDate: new Date(entry.startDate),
        endDate: new Date(entry.endDate),
        cliffDate: entry.cliffDate ? new Date(entry.cliffDate) : undefined,
        taperStartDate: entry.taperStartDate
          ? new Date(entry.taperStartDate)
          : undefined,
        taperEndDate: entry.taperEndDate
          ? new Date(entry.taperEndDate)
          : undefined,
        isActive: entry.isActive,
      };

      const summary = summarizeRewardScheduleHealth(scheduleInput, {
        now: referenceDate,
      });

      return {
        ...summary,
        payoutTimingRisk: summary.daysUntilEnd <= 0 ? "expired" : summary.daysUntilEnd <= 7 ? "imminent" : "normal",
      } satisfies RewardScheduleHealthSummary & { payoutTimingRisk: string };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      referenceDate: referenceDate.toISOString(),
      health,
    });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to generate reward schedule dry-run",
    });
  }
});

export default router;
