/**
 * Operator-facing endpoints for the scheduled reconciliation run history
 * (BE-124). Operators can query run summaries and per-wallet drift detail.
 */
import { Router, Request, Response } from "express";
import {
  getScheduledReconciliationRuns,
  queryScheduledReconciliationRuns,
  getScheduledReconciliationRunById,
  getConsecutiveUnhealthyCount,
} from "../services/scheduledReconciliationService";

const router = Router();

/**
 * GET /api/reconciliation/runs
 *
 * Returns scheduled reconciliation run history, newest first, with optional
 * status and date-range filters.
 *
 * Query parameters:
 *   status     — success | partial | failed | skipped (optional)
 *   startDate  — ISO timestamp lower bound (optional)
 *   endDate    — ISO timestamp upper bound (optional)
 *   limit      — max runs to return, 1–100 (default 50)
 */
router.get("/runs", (req: Request, res: Response) => {
  const status = req.query.status as
    | "success"
    | "partial"
    | "failed"
    | "skipped"
    | undefined;

  if (
    status !== undefined &&
    !["success", "partial", "failed", "skipped"].includes(status)
  ) {
    res.status(400).json({
      error: "INVALID_STATUS",
      message: "status must be success, partial, failed, or skipped.",
    });
    return;
  }

  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), 100)
    : 50;

  const runs = queryScheduledReconciliationRuns({
    status,
    startDate: req.query.startDate as string | undefined,
    endDate: req.query.endDate as string | undefined,
    limit,
  });

  res.json({ data: runs, limit });
});

/**
 * GET /api/reconciliation/runs/:id
 *
 * Returns a single scheduled reconciliation run including its per-wallet
 * drift detail.
 */
router.get(
  "/runs/:id",
  (req: Request, res: Response) => {
    const run = getScheduledReconciliationRunById(req.params.id);
    if (!run) {
      res.status(404).json({
        error: "RUN_NOT_FOUND",
        message: `No scheduled reconciliation run with id ${req.params.id}.`,
      });
      return;
    }
    res.json(run);
  },
);

/**
 * GET /api/reconciliation/status
 *
 * Returns scheduler health: the latest run summary and the current
 * consecutive failed/skipped count used for unhealthy alerting.
 */
router.get("/status", (_req: Request, res: Response) => {
  const runs = getScheduledReconciliationRuns();
  const latest = runs.length > 0 ? runs[0] : null;

  res.json({
    consecutiveUnhealthyCount: getConsecutiveUnhealthyCount(),
    runCount: runs.length,
    latest,
  });
});

export default router;
