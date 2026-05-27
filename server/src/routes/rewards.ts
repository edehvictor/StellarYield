import { Router, Request, Response } from "express";
import { RewardScheduleRegistry } from "../services/rewardScheduleRegistry";

const router = Router();

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

export default router;
