import { Router, Request, Response } from "express";
import { RewardScheduleRegistry } from "../services/rewardScheduleRegistry";

const rewardCampaignCalendarRouter = Router();

rewardCampaignCalendarRouter.get(
  "/campaign-calendar",
  async (_req: Request, res: Response) => {
    try {
      const campaigns = await RewardScheduleRegistry.getCampaignCalendar();
      res.json({ generatedAt: new Date().toISOString(), campaigns });
    } catch {
      res.status(503).json({
        code: "campaign_calendar_unavailable",
        error: "Reward campaign calendar is temporarily unavailable.",
      });
    }
  },
);

export default rewardCampaignCalendarRouter;
