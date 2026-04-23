import cron from "node-cron";
import {
  getAuditLogs,
  verifyAuditTrailIntegrity,
  getAuditStatistics,
} from "../middleware/audit";

/**
 * Audit Monitoring & Alerting System
 * Provides real-time monitoring and alerting for audit trail events
 */

export interface AuditAlert {
  id: string;
  timestamp: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  type: string;
  message: string;
  details: Record<string, unknown>;
}

export interface AuditMonitoringConfig {
  enableIntegrityChecks?: boolean;
  integrityCheckInterval?: string; // cron expression
  enableAnomalyDetection?: boolean;
  enableSuspiciousActivityDetection?: boolean;
  alertWebhook?: string;
  alertEmail?: string;
  thresholds?: {
    failedAttemptsThreshold?: number;
    unusualActivityThreshold?: number;
    integrityCheckFailureThreshold?: number;
  };
}

const alerts: AuditAlert[] = [];
let monitoringJobs: ReturnType<typeof cron.schedule>[] = [];

/**
 * Create and store an alert
 */
export function createAlert(
  type: string,
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  message: string,
  details: Record<string, unknown> = {},
): AuditAlert {
  const alert: AuditAlert = {
    id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    severity,
    type,
    message,
    details,
  };

  alerts.push(alert);

  // Keep only last 1000 alerts
  if (alerts.length > 1000) {
    alerts.shift();
  }

  console.log(`[AUDIT ALERT] ${severity}: ${message}`, details);

  return alert;
}

/**
 * Get recent alerts
 */
export function getAlerts(filters?: {
  severity?: string;
  type?: string;
  limit?: number;
}): AuditAlert[] {
  let results = [...alerts];

  if (filters?.severity) {
    results = results.filter((a) => a.severity === filters.severity);
  }

  if (filters?.type) {
    results = results.filter((a) => a.type === filters.type);
  }

  results.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const limit = filters?.limit || 100;
  return results.slice(0, limit);
}

/**
 * Send alert to webhook
 */
export async function sendAlertToWebhook(
  alert: AuditAlert,
  webhookUrl: string,
): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(alert),
    });

    if (!response.ok) {
      console.error(`Failed to send alert to webhook: ${response.statusText}`);
    }
  } catch (error) {
    console.error("Error sending alert to webhook:", error);
  }
}

/**
 * Detect suspicious activity patterns
 */
export async function detectSuspiciousActivity(): Promise<void> {
  try {
    const logs = await getAuditLogs({ limit: 1000 });
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // Group by user and action
    const userActions: Record<string, Record<string, number>> = {};

    for (const log of logs) {
      const logTime = new Date(log.timestamp).getTime();
      if (logTime < oneHourAgo) continue;

      if (!userActions[log.userId]) {
        userActions[log.userId] = {};
      }

      const key = `${log.action}:${log.resource}`;
      userActions[log.userId][key] = (userActions[log.userId][key] || 0) + 1;
    }

    // Check for suspicious patterns
    for (const [userId, actions] of Object.entries(userActions)) {
      for (const [action, count] of Object.entries(actions)) {
        // Alert on unusual frequency (e.g., >10 same actions in 1 hour)
        if (count > 10) {
          createAlert(
            "SUSPICIOUS_ACTIVITY",
            "HIGH",
            `User ${userId} performed ${action} ${count} times in 1 hour`,
            { userId, action, count },
          );
        }
      }
    }

    // Check for failed operations
    const failedOps = logs.filter((log) => log.status >= 400);
    if (failedOps.length > 20) {
      createAlert(
        "HIGH_FAILURE_RATE",
        "MEDIUM",
        `High failure rate detected: ${failedOps.length} failed operations in recent logs`,
        { failedCount: failedOps.length },
      );
    }

    // Check for unusual IP addresses
    const ipAddresses: Record<string, number> = {};
    for (const log of logs) {
      ipAddresses[log.ipAddress] = (ipAddresses[log.ipAddress] || 0) + 1;
    }

    const unusualIPs = Object.entries(ipAddresses).filter(
      ([_, count]) => count === 1,
    );
    if (unusualIPs.length > 5) {
      createAlert(
        "UNUSUAL_IP_ADDRESSES",
        "LOW",
        `Multiple unusual IP addresses detected: ${unusualIPs.length} unique IPs with single access`,
        { unusualIPCount: unusualIPs.length },
      );
    }
  } catch (error) {
    console.error("Error detecting suspicious activity:", error);
  }
}

/**
 * Check audit trail integrity
 */
export async function checkAuditTrailIntegrity(): Promise<void> {
  try {
    const logs = await getAuditLogs({ limit: 10000 });
    const verification = verifyAuditTrailIntegrity(logs);

    if (!verification.isValid) {
      createAlert(
        "AUDIT_TRAIL_INTEGRITY_FAILURE",
        "CRITICAL",
        `Audit trail integrity check failed: ${verification.invalidEntries.length} invalid entries detected`,
        {
          invalidEntries: verification.invalidEntries,
          totalEntries: logs.length,
        },
      );
    }
  } catch (error) {
    console.error("Error checking audit trail integrity:", error);
    createAlert(
      "AUDIT_INTEGRITY_CHECK_ERROR",
      "HIGH",
      "Failed to perform audit trail integrity check",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}

/**
 * Detect anomalies in audit patterns
 */
export async function detectAnomalies(): Promise<void> {
  try {
    const stats = await getAuditStatistics();

    // Check for unusual action distribution
    const actionCounts = Object.values(stats.actionCounts);
    if (actionCounts.length > 0) {
      const avgCount =
        actionCounts.reduce((a, b) => a + b, 0) / actionCounts.length;
      const maxCount = Math.max(...actionCounts);

      // Alert if one action is significantly more frequent
      if (maxCount > avgCount * 5) {
        const unusualAction = Object.entries(stats.actionCounts).find(
          ([_, count]) => count === maxCount,
        );

        createAlert(
          "UNUSUAL_ACTION_DISTRIBUTION",
          "MEDIUM",
          `Unusual action distribution detected: ${unusualAction?.[0]} performed ${maxCount} times`,
          { action: unusualAction?.[0], count: maxCount, average: avgCount },
        );
      }
    }

    // Check for sudden increase in activity
    const recentLogs = await getAuditLogs({ limit: 100 });
    const olderLogs = await getAuditLogs({ limit: 200 });
    olderLogs.splice(0, 100); // Get logs 100-200

    if (recentLogs.length > olderLogs.length * 2) {
      createAlert(
        "ACTIVITY_SPIKE",
        "MEDIUM",
        `Unusual activity spike detected: ${recentLogs.length} recent actions vs ${olderLogs.length} older actions`,
        { recentCount: recentLogs.length, olderCount: olderLogs.length },
      );
    }
  } catch (error) {
    console.error("Error detecting anomalies:", error);
  }
}

/**
 * Start monitoring jobs
 */
export function startAuditMonitoring(config: AuditMonitoringConfig = {}): void {
  const {
    enableIntegrityChecks = true,
    integrityCheckInterval = "0 * * * *", // Every hour
    enableAnomalyDetection = true,
    enableSuspiciousActivityDetection = true,
  } = config;

  console.log("Starting audit monitoring...");

  // Integrity check job
  if (enableIntegrityChecks) {
    const integrityJob = cron.schedule(integrityCheckInterval, async () => {
      console.log("Running audit trail integrity check...");
      await checkAuditTrailIntegrity();
    });
    monitoringJobs.push(integrityJob );
  }

  // Anomaly detection job (every 15 minutes)
  if (enableAnomalyDetection) {
    const anomalyJob = cron.schedule("*/15 * * * *", async () => {
      console.log("Running anomaly detection...");
      await detectAnomalies();
    });
    monitoringJobs.push(anomalyJob );
  }

  // Suspicious activity detection job (every 5 minutes)
  if (enableSuspiciousActivityDetection) {
    const suspiciousJob = cron.schedule("*/5 * * * *", async () => {
      console.log("Running suspicious activity detection...");
      await detectSuspiciousActivity();
    });
    monitoringJobs.push(suspiciousJob );
  }

  console.log(`Audit monitoring started with ${monitoringJobs.length} jobs`);
}

/**
 * Stop monitoring jobs
 */
export function stopAuditMonitoring(): void {
  for (const job of monitoringJobs) {
    job.stop();
  }
  monitoringJobs = [];
  console.log("Audit monitoring stopped");
}

/**
 * Get monitoring status
 */
export function getMonitoringStatus(): {
  isRunning: boolean;
  activeJobs: number;
  recentAlerts: AuditAlert[];
} {
  return {
    isRunning: monitoringJobs.length > 0,
    activeJobs: monitoringJobs.length,
    recentAlerts: getAlerts({ limit: 10 }),
  };
}

/**
 * Generate monitoring report
 */
export async function generateMonitoringReport(): Promise<{
  timestamp: string;
  stats: Awaited<ReturnType<typeof getAuditStatistics>>;
  alerts: AuditAlert[];
  status: ReturnType<typeof getMonitoringStatus>;
}> {
  const stats = await getAuditStatistics();
  const recentAlerts = getAlerts({ limit: 50 });
  const status = getMonitoringStatus();

  return {
    timestamp: new Date().toISOString(),
    stats,
    alerts: recentAlerts,
    status,
  };
}

/**
 * Export monitoring data
 */
export async function exportMonitoringData(): Promise<string> {
  const report = await generateMonitoringReport();

  return JSON.stringify(report, null, 2);
}
