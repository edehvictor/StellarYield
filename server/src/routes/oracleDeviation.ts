import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { getDeviationLog, getGroupedDeviations } from "../services/oracleDeviationSentinel";
import { groupOracleDeviations } from "../services/oracleDeviationGrouper";
import type { DeviationEvent } from "../services/oracleDeviationSentinel";

const router = Router();

const oracleRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many oracle deviation requests. Please try again later." },
});

/**
 * GET /api/oracle-deviations/grouped
 * Returns deviation events from the in-memory sentinel log, grouped by asset + severity.
 */
router.get("/grouped", oracleRateLimiter, (_req: Request, res: Response) => {
  try {
    const grouped = getGroupedDeviations();
    res.json({ success: true, count: grouped.length, data: grouped });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch grouped oracle deviations",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/oracle-deviations/group
 * Group an arbitrary batch of DeviationEvents (useful for tests / external callers).
 */
router.post("/group", oracleRateLimiter, (req: Request, res: Response) => {
  try {
    const { events, options } = req.body as {
      events?: DeviationEvent[];
      options?: Record<string, unknown>;
    };
    if (!Array.isArray(events)) {
      res.status(400).json({ error: "events must be an array of DeviationEvent objects" });
      return;
    }
    const grouped = groupOracleDeviations(events, options ?? {});
    res.json({ success: true, count: grouped.length, data: grouped });
  } catch (error) {
    res.status(500).json({
      error: "Failed to group oracle deviations",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/oracle-deviations/log
 * Raw, ungrouped event log (newest first) — useful for debugging.
 */
router.get("/log", (_req: Request, res: Response) => {
  res.json({ success: true, count: getDeviationLog().length, data: getDeviationLog() });
});

export default router;
