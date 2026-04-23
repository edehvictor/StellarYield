import cron from "node-cron";
import {
  generateWeeklyYieldReports,
  filterReportsWithActivity,
  getReportStatistics,
  exportReportsToCSV,
  WeeklyYieldReport,
} from "../services/weeklyYieldReportService";
import { sendBatchEmails, EmailOptions } from "../services/emailService";

/**
 * Weekly Yield Report Job
 * Generates and sends weekly yield reports to subscribed users
 */

export interface JobConfig {
  enabled: boolean;
  schedule: string; // Cron expression (default: every Monday at 9 AM)
  sendEmails: boolean;
  filterByActivity: boolean;
  logResults: boolean;
}

let jobHandle: ReturnType<typeof cron.schedule> | null = null;

/**
 * Start the weekly yield report job
 */
export function startWeeklyYieldReportJob(
  config: Partial<JobConfig> = {},
): void {
  const finalConfig: JobConfig = {
    enabled: config.enabled !== false,
    schedule: config.schedule || "0 9 * * 1", // Every Monday at 9 AM
    sendEmails: config.sendEmails !== false,
    filterByActivity: config.filterByActivity !== false,
    logResults: config.logResults !== false,
  };

  if (!finalConfig.enabled) {
    console.log("Weekly yield report job is disabled");
    return;
  }

  console.log(
    `Starting weekly yield report job with schedule: ${finalConfig.schedule}`,
  );

  jobHandle = cron.schedule(finalConfig.schedule, async () => {
    try {
      await runWeeklyYieldReportJob(finalConfig);
    } catch (error) {
      console.error("Weekly yield report job failed:", error);
    }
  });
}

/**
 * Stop the weekly yield report job
 */
export function stopWeeklyYieldReportJob(): void {
  if (jobHandle) {
    jobHandle.stop();
    jobHandle = null;
    console.log("Weekly yield report job stopped");
  }
}

/**
 * Run the weekly yield report job
 */
export async function runWeeklyYieldReportJob(config: JobConfig): Promise<{
  success: boolean;
  reportsGenerated: number;
  emailsSent: number;
  emailsFailed: number;
  statistics: Record<string, unknown>;
  timestamp: string;
}> {
  const startTime = Date.now();
  console.log("Running weekly yield report job...");

  try {
    // Generate reports
    console.log("Generating weekly yield reports...");
    let reports = await generateWeeklyYieldReports();

    // Filter by activity if configured
    if (config.filterByActivity) {
      const beforeFilter = reports.length;
      reports = filterReportsWithActivity(reports);
      console.log(
        `Filtered reports: ${beforeFilter} -> ${reports.length} (with activity)`,
      );
    }

    // Get statistics
    const statistics = getReportStatistics(reports);

    if (config.logResults) {
      console.log("Report Statistics:", statistics);
    }

    // Send emails
    let emailsSent = 0;
    let emailsFailed = 0;

    if (config.sendEmails && reports.length > 0) {
      console.log(`Sending ${reports.length} weekly yield report emails...`);

      const results = await sendBatchEmails(
        reports.map((report) => ({
          email: report.email,
          data: report,
        })),
        (report) => ({
          to: report.email,
          subject: `Your Weekly Yield Report - ${report.period.startDate} to ${report.period.endDate}`,
          html: "",
        }),
      );

      emailsSent = results.sent;
      emailsFailed = results.failed;

      if (config.logResults) {
        console.log(`Emails sent: ${emailsSent}, failed: ${emailsFailed}`);
        if (results.errors.length > 0) {
          console.error("Email errors:", results.errors);
        }
      }
    }

    const duration = Date.now() - startTime;
    const result = {
      success: true,
      reportsGenerated: reports.length,
      emailsSent,
      emailsFailed,
      statistics,
      timestamp: new Date().toISOString(),
    };

    if (config.logResults) {
      console.log(`Weekly yield report job completed in ${duration}ms`, result);
    }

    return result;
  } catch (error) {
    console.error("Weekly yield report job error:", error);
    throw error;
  }
}

/**
 * Run job immediately (for testing)
 */
export async function runWeeklyYieldReportJobNow(): Promise<
  Record<string, unknown>
> {
  const config: JobConfig = {
    enabled: true,
    schedule: "0 9 * * 1",
    sendEmails: true,
    filterByActivity: true,
    logResults: true,
  };

  return runWeeklyYieldReportJob(config);
}

/**
 * Get job status
 */
export function getJobStatus(): {
  running: boolean;
  nextRun?: string;
} {
  return {
    running: jobHandle !== null,
    nextRun: jobHandle ? "Check cron schedule" : undefined,
  };
}

/**
 * Export reports for a specific week
 */
export async function exportWeeklyReports(): Promise<string> {
  const reports = await generateWeeklyYieldReports();
  return exportReportsToCSV(reports);
}
