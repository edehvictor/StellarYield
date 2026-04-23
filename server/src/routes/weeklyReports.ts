import { Router, Request, Response } from "express";
import {
  generateWeeklyYieldReports,
  filterReportsWithActivity,
  getReportStatistics,
  exportReportsToCSV,
  getWeeklyDateRange,
  formatDateForDisplay,
} from "../services/weeklyYieldReportService";
import {
  runWeeklyYieldReportJobNow,
  getJobStatus,
  startWeeklyYieldReportJob,
  stopWeeklyYieldReportJob,
} from "../jobs/weeklyYieldReportJob";

const weeklyReportsRouter = Router();

/**
 * Admin authentication middleware
 */
function requireAdmin(req: Request, res: Response, next: () => void): void {
  const user = (req as unknown as Record<string, unknown>).user as
    | { role?: string }
    | undefined;

  if (!user || user.role !== "ADMIN") {
    res.status(403).json({ error: "Unauthorized: Admin access required" });
    return;
  }

  next();
}

/**
 * Get weekly yield reports
 * GET /api/weekly-reports
 */
weeklyReportsRouter.get(
  "/",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { filterByActivity, limit } = req.query;

      let reports = await generateWeeklyYieldReports();

      if (filterByActivity === "true") {
        reports = filterReportsWithActivity(reports);
      }

      if (limit) {
        reports = reports.slice(0, parseInt(limit as string));
      }

      const { startDate, endDate } = getWeeklyDateRange();

      res.json({
        success: true,
        count: reports.length,
        period: {
          startDate: formatDateForDisplay(startDate),
          endDate: formatDateForDisplay(endDate),
        },
        reports,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to retrieve reports",
      });
    }
  },
);

/**
 * Get report statistics
 * GET /api/weekly-reports/stats
 */
weeklyReportsRouter.get(
  "/stats",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const reports = await generateWeeklyYieldReports();
      const statistics = getReportStatistics(reports);
      const { startDate, endDate } = getWeeklyDateRange();

      res.json({
        success: true,
        statistics,
        period: {
          startDate: formatDateForDisplay(startDate),
          endDate: formatDateForDisplay(endDate),
        },
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to retrieve statistics",
      });
    }
  },
);

/**
 * Export reports as CSV
 * GET /api/weekly-reports/export
 */
weeklyReportsRouter.get(
  "/export",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { filterByActivity } = req.query;

      let reports = await generateWeeklyYieldReports();

      if (filterByActivity === "true") {
        reports = filterReportsWithActivity(reports);
      }

      const csv = exportReportsToCSV(reports);
      const { startDate } = getWeeklyDateRange();

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="weekly-yield-reports-${startDate.toISOString().split("T")[0]}.csv"`,
      );
      res.send(csv);
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to export reports",
      });
    }
  },
);

/**
 * Get job status
 * GET /api/weekly-reports/job/status
 */
weeklyReportsRouter.get(
  "/job/status",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const status = getJobStatus();

      res.json({
        success: true,
        status,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to get job status",
      });
    }
  },
);

/**
 * Run job immediately
 * POST /api/weekly-reports/job/run
 */
weeklyReportsRouter.post(
  "/job/run",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await runWeeklyYieldReportJobNow();

      res.json({
        success: true,
        message: "Weekly yield report job executed",
        result,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to run job",
      });
    }
  },
);

/**
 * Start job
 * POST /api/weekly-reports/job/start
 */
weeklyReportsRouter.post(
  "/job/start",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { schedule, sendEmails, filterByActivity } = req.body;

      startWeeklyYieldReportJob({
        enabled: true,
        schedule: schedule || "0 9 * * 1",
        sendEmails: sendEmails !== false,
        filterByActivity: filterByActivity !== false,
      });

      const status = getJobStatus();

      res.json({
        success: true,
        message: "Weekly yield report job started",
        status,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to start job",
      });
    }
  },
);

/**
 * Stop job
 * POST /api/weekly-reports/job/stop
 */
weeklyReportsRouter.post(
  "/job/stop",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      stopWeeklyYieldReportJob();

      const status = getJobStatus();

      res.json({
        success: true,
        message: "Weekly yield report job stopped",
        status,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to stop job",
      });
    }
  },
);

/**
 * Get single report
 * GET /api/weekly-reports/:userId
 */
weeklyReportsRouter.get(
  "/:userId",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.params;

      const reports = await generateWeeklyYieldReports();
      const report = reports.find((r) => r.userId === userId);

      if (!report) {
        res.status(404).json({
          error: "Report not found",
        });
        return;
      }

      res.json({
        success: true,
        report,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to retrieve report",
      });
    }
  },
);

/**
 * Get user's weekly reports history
 * GET /api/weekly-reports/user/:userId/history
 */
weeklyReportsRouter.get(
  "/user/:userId/history",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.params;
      const { limit } = req.query;

      // In production, query historical reports from database
      const reports = await generateWeeklyYieldReports();
      const userReports = reports.filter((r) => r.userId === userId);

      if (limit) {
        userReports.slice(0, parseInt(limit as string));
      }

      res.json({
        success: true,
        count: userReports.length,
        reports: userReports,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to retrieve history",
      });
    }
  },
);

/**
 * Subscribe user to weekly reports
 * POST /api/weekly-reports/subscribe
 */
weeklyReportsRouter.post(
  "/subscribe",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId, email } = req.body;

      if (!userId || !email) {
        res.status(400).json({
          error: "userId and email are required",
        });
        return;
      }

      // In production, update user subscription in database
      res.json({
        success: true,
        message: `User ${userId} subscribed to weekly reports`,
        userId,
        email,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to subscribe",
      });
    }
  },
);

/**
 * Unsubscribe user from weekly reports
 * POST /api/weekly-reports/unsubscribe
 */
weeklyReportsRouter.post(
  "/unsubscribe",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.body;

      if (!userId) {
        res.status(400).json({
          error: "userId is required",
        });
        return;
      }

      // In production, update user subscription in database
      res.json({
        success: true,
        message: `User ${userId} unsubscribed from weekly reports`,
        userId,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to unsubscribe",
      });
    }
  },
);

export default weeklyReportsRouter;
