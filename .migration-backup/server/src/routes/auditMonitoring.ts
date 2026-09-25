import { Router, Request, Response } from "express";
import {
  getAlerts,
  getMonitoringStatus,
  generateMonitoringReport,
  exportMonitoringData,
  startAuditMonitoring,
  stopAuditMonitoring,
} from "../utils/auditMonitoring";
import { sendError } from "../utils/errorResponse";

const auditMonitoringRouter = Router();

/**
 * Admin authentication middleware
 */
function requireAdmin(req: Request, res: Response, next: () => void): void {
  const user = (req as unknown as Record<string, unknown>).user as
    | { role?: string }
    | undefined;

  if (!user || user.role !== "ADMIN") {
    sendError(res, 403, "UNAUTHORIZED", "Unauthorized: Admin access required");
    return;
  }

  next();
}

/**
 * Get recent alerts
 * GET /api/audit-monitoring/alerts
 */
auditMonitoringRouter.get(
  "/alerts",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { severity, type, limit } = req.query;

      const alerts = getAlerts({
        severity: severity as string,
        type: type as string,
        limit: limit ? parseInt(limit as string) : undefined,
      });

      res.json({
        success: true,
        count: alerts.length,
        alerts,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to retrieve alerts",
      });
    }
  },
);

/**
 * Get monitoring status
 * GET /api/audit-monitoring/status
 */
auditMonitoringRouter.get(
  "/status",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const status = getMonitoringStatus();

      res.json({
        success: true,
        status,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to retrieve monitoring status",
      });
    }
  },
);

/**
 * Get monitoring report
 * GET /api/audit-monitoring/report
 */
auditMonitoringRouter.get(
  "/report",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const report = await generateMonitoringReport();

      res.json({
        success: true,
        report,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate monitoring report",
      });
    }
  },
);

/**
 * Export monitoring data
 * GET /api/audit-monitoring/export
 */
auditMonitoringRouter.get(
  "/export",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await exportMonitoringData();

      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="audit-monitoring.json"',
      );
      res.send(data);
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to export monitoring data",
      });
    }
  },
);

/**
 * Start monitoring
 * POST /api/audit-monitoring/start
 */
auditMonitoringRouter.post(
  "/start",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const config = req.body;
      startAuditMonitoring(config);

      const status = getMonitoringStatus();

      res.json({
        success: true,
        message: "Audit monitoring started",
        status,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to start monitoring",
      });
    }
  },
);

/**
 * Stop monitoring
 * POST /api/audit-monitoring/stop
 */
auditMonitoringRouter.post(
  "/stop",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      stopAuditMonitoring();

      const status = getMonitoringStatus();

      res.json({
        success: true,
        message: "Audit monitoring stopped",
        status,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to stop monitoring",
      });
    }
  },
);

/**
 * Get alerts by severity
 * GET /api/audit-monitoring/alerts/critical
 */
auditMonitoringRouter.get(
  "/alerts/:severity",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { severity } = req.params;
      const { limit } = req.query;

      const alerts = getAlerts({
        severity: severity.toUpperCase(),
        limit: limit ? parseInt(limit as string) : undefined,
      });

      res.json({
        success: true,
        count: alerts.length,
        severity: severity.toUpperCase(),
        alerts,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to retrieve alerts",
      });
    }
  },
);

export default auditMonitoringRouter;
