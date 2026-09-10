/**
 * Weekly Yield Report Service
 * Generates and manages weekly yield reports for users
 */

import { PrismaClient } from "@prisma/client";
import { computeChecksum, computeObjectChecksum } from "../utils/checksum";

const prisma = new PrismaClient();

export type ReportGenerationStatus = "SUCCESS" | "MISSING" | "DELAYED" | "FAILED";

export interface WeeklyReportGenerationRecord {
  id: string;
  reportType: string;
  periodStart: Date;
  periodEnd: Date;
  status: ReportGenerationStatus;
  expectedAt: Date;
  generatedAt: Date | null;
  errorMessage: string | null;
  retryCount: number;
  lastRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WeeklyReportHealthCheck {
  reportType: string;
  currentPeriod: {
    periodStart: string;
    periodEnd: string;
    expectedAt: string;
    status: ReportGenerationStatus;
    generatedAt: string | null;
    errorMessage: string | null;
    retryCount: number;
  };
  previousPeriods: Array<{
    periodStart: string;
    periodEnd: string;
    expectedAt: string;
    status: ReportGenerationStatus;
    generatedAt: string | null;
    errorMessage: string | null;
    retryCount: number;
  }>;
  summary: {
    totalPeriodsChecked: number;
    successful: number;
    missing: number;
    delayed: number;
    failed: number;
    needsCatchUp: boolean;
  };
}

export interface UserYieldData {
  userId: string;
  walletAddress: string;
  email: string;
  userName: string;
  subscribed: boolean;
}

export interface VaultYieldData {
  vaultId: string;
  vaultName: string;
  yield: number;
  yieldPercentage: number;
  apy: number;
  tvl: number;
  deposits: number;
  withdrawals: number;
}

export interface WeeklyYieldReport {
  userId: string;
  walletAddress: string;
  email: string;
  userName: string;
  weeklyYield: number;
  weeklyYieldPercentage: number;
  totalYield: number;
  vaultCount: number;
  topVaults: VaultYieldData[];
  period: {
    startDate: string;
    endDate: string;
  };
  generatedAt: string;
}

/**
 * Mock data generator for demonstration
 * In production, this would query your actual database
 */
export function generateMockUserYieldData(userId: string): UserYieldData {
  return {
    userId,
    walletAddress: `G${Math.random().toString(36).substring(2, 56)}`,
    email: `user-${userId}@example.com`,
    userName: `User ${userId}`,
    subscribed: true,
  };
}

/**
 * Mock vault yield data generator
 * In production, this would calculate actual yields from transactions
 */
export function generateMockVaultYieldData(): VaultYieldData[] {
  const vaults = [
    { name: "Blend Yield", apy: 6.5 },
    { name: "Soroswap Liquidity", apy: 12.2 },
    { name: "DeFindex Yield Index", apy: 8.9 },
    { name: "Stellar Staking", apy: 5.0 },
    { name: "Protocol X Farming", apy: 15.3 },
  ];

  return vaults.map((vault, index) => ({
    vaultId: `vault-${index}`,
    vaultName: vault.name,
    yield: Math.random() * 500 + 50,
    yieldPercentage: Math.random() * 2 + 0.5,
    apy: vault.apy,
    tvl: Math.random() * 10000000 + 1000000,
    deposits: Math.random() * 5000,
    withdrawals: Math.random() * 2000,
  }));
}

/**
 * Calculate weekly yield report for a user
 * In production, this would query actual transaction data
 */
export function calculateWeeklyYieldReport(
  user: UserYieldData,
  vaultYields: VaultYieldData[],
  startDate: Date,
  endDate: Date,
): WeeklyYieldReport {
  // Calculate total weekly yield
  const weeklyYield = vaultYields.reduce((sum, vault) => sum + vault.yield, 0);

  // Calculate average yield percentage
  const weeklyYieldPercentage =
    vaultYields.length > 0
      ? vaultYields.reduce((sum, vault) => sum + vault.yieldPercentage, 0) /
        vaultYields.length
      : 0;

  // Mock total yield (in production, query from database)
  const totalYield = weeklyYield * 52 * (Math.random() * 0.5 + 0.8);

  // Sort vaults by yield and get top 5
  const topVaults = vaultYields.sort((a, b) => b.yield - a.yield).slice(0, 5);

  return {
    userId: user.userId,
    walletAddress: user.walletAddress,
    email: user.email,
    userName: user.userName,
    weeklyYield,
    weeklyYieldPercentage,
    totalYield,
    vaultCount: vaultYields.length,
    topVaults,
    period: {
      startDate: startDate.toISOString().split("T")[0],
      endDate: endDate.toISOString().split("T")[0],
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Get date range for the past 7 days
 */
export function getWeeklyDateRange(): { startDate: Date; endDate: Date } {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

  return { startDate, endDate };
}

/**
 * Format date for display
 */
export function formatDateForDisplay(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Get all subscribed users
 * In production, query from database
 */
export async function getSubscribedUsers(): Promise<UserYieldData[]> {
  // Mock implementation - in production, query database
  const userIds = ["user-1", "user-2", "user-3", "user-4", "user-5"];
  return userIds.map((id) => generateMockUserYieldData(id));
}

/**
 * Get user vault yields
 * In production, calculate from actual transaction data
 */
export async function getUserVaultYields(): Promise<VaultYieldData[]> {
  // Mock implementation - in production, query database and calculate
  return generateMockVaultYieldData();
}

/**
 * Generate weekly yield reports for all subscribed users
 */
export async function generateWeeklyYieldReports(): Promise<
  WeeklyYieldReport[]
> {
  const users = await getSubscribedUsers();
  const { startDate, endDate } = getWeeklyDateRange();
  const reports: WeeklyYieldReport[] = [];

  for (const user of users) {
    if (!user.subscribed) continue;

    try {
      const vaultYields = await getUserVaultYields();
      const report = calculateWeeklyYieldReport(
        user,
        vaultYields,
        startDate,
        endDate,
      );
      reports.push(report);
    } catch (error) {
      console.error(
        `Failed to generate report for user ${user.userId}:`,
        error,
      );
    }
  }

  return reports;
}

/**
 * Filter reports to only include those with yield activity
 */
export function filterReportsWithActivity(
  reports: WeeklyYieldReport[],
): WeeklyYieldReport[] {
  return reports.filter(
    (report) => report.weeklyYield > 0 && report.topVaults.length > 0,
  );
}

/**
 * Get report statistics
 */
export function getReportStatistics(reports: WeeklyYieldReport[]): {
  totalReports: number;
  totalYieldGenerated: number;
  averageYieldPerUser: number;
  topPerformer: WeeklyYieldReport | null;
  usersWithActivity: number;
} {
  if (reports.length === 0) {
    return {
      totalReports: 0,
      totalYieldGenerated: 0,
      averageYieldPerUser: 0,
      topPerformer: null,
      usersWithActivity: 0,
    };
  }

  const totalYield = reports.reduce((sum, r) => sum + r.weeklyYield, 0);
  const reportsWithActivity = reports.filter((r) => r.weeklyYield > 0);
  const topPerformer = reports.reduce((max, r) =>
    r.weeklyYield > max.weeklyYield ? r : max,
  );

  return {
    totalReports: reports.length,
    totalYieldGenerated: totalYield,
    averageYieldPerUser: totalYield / reports.length,
    topPerformer,
    usersWithActivity: reportsWithActivity.length,
  };
}

/**
 * Export reports to CSV format
 */
export function exportReportsToCSV(reports: WeeklyYieldReport[]): string {
  const headers = [
    "User ID",
    "Email",
    "Wallet Address",
    "Weekly Yield",
    "Weekly Yield %",
    "Total Yield",
    "Vault Count",
    "Top Vault",
    "Top Vault Yield",
    "Period Start",
    "Period End",
  ];

  const rows = reports.map((report) => [
    report.userId,
    report.email,
    report.walletAddress,
    report.weeklyYield.toFixed(2),
    report.weeklyYieldPercentage.toFixed(2),
    report.totalYield.toFixed(2),
    report.vaultCount,
    report.topVaults[0]?.vaultName || "N/A",
    report.topVaults[0]?.yield.toFixed(2) || "N/A",
    report.period.startDate,
    report.period.endDate,
  ]);

  const csv = [
    headers.join(","),
    ...rows.map((row) =>
      row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","),
    ),
  ].join("\n");

  return csv;
}

export interface ReportArtifact {
  format: 'csv' | 'html' | string;
  content: string;
  checksum: string; // sha256 hex
  generatedAt: string;
}

/**
 * Generate an artifact for weekly reports including a stable checksum.
 */
export function generateWeeklyReportsArtifact(reports: WeeklyYieldReport[]): ReportArtifact {
  const csv = exportReportsToCSV(reports);
  const checksum = computeChecksum(csv);

  return {
    format: 'csv',
    content: csv,
    checksum,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Verify the checksum of an artifact. Returns true when matching, false when missing/mismatched.
 */
export function verifyReportArtifactChecksum(artifact: Partial<ReportArtifact>): boolean {
  if (!artifact || !artifact.content) return false;
  if (!artifact.checksum) return false;
  const actual = computeChecksum(artifact.content);
  return actual === artifact.checksum;
}

/**
 * Get the expected generation time for a weekly period
 * Reports are expected to be generated on Monday at 9 AM for the previous week
 */
export function getExpectedGenerationTime(periodStart: Date): Date {
  // Find the Monday after the period ends (period is 7 days, so periodEnd is Monday)
  const expected = new Date(periodStart);
  expected.setDate(expected.getDate() + 7); // Next Monday
  expected.setHours(9, 0, 0, 0); // 9 AM
  return expected;
}

/**
 * Get the period start date for a given week offset from now
 * Week 0 = current week (most recent completed week)
 * Week -1 = previous week, etc.
 */
export function getWeeklyPeriodStart(weekOffset: number = 0): Date {
  const now = new Date();
  // Find the most recent Monday (start of current week)
  const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const mostRecentMonday = new Date(now);
  mostRecentMonday.setDate(now.getDate() - daysSinceMonday);
  mostRecentMonday.setHours(0, 0, 0, 0);

  // Adjust by week offset
  const periodStart = new Date(mostRecentMonday);
  periodStart.setDate(mostRecentMonday.getDate() + weekOffset * 7);
  return periodStart;
}

/**
 * Get the period end date for a given period start
 */
export function getWeeklyPeriodEnd(periodStart: Date): Date {
  const periodEnd = new Date(periodStart);
  periodEnd.setDate(periodStart.getDate() + 6); // 6 days later = Sunday
  periodEnd.setHours(23, 59, 59, 999);
  return periodEnd;
}

/**
 * Record the start of a report generation attempt
 */
export async function recordGenerationAttempt(
  reportType: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<WeeklyReportGenerationRecord> {
  const expectedAt = getExpectedGenerationTime(periodStart);

  const record = await prisma.weeklyReportGeneration.upsert({
    where: {
      reportType_periodStart: {
        reportType,
        periodStart,
      },
    },
    update: {
      status: "MISSING", // Will be updated to SUCCESS or FAILED after attempt
      expectedAt,
      retryCount: { increment: 1 },
      lastRetryAt: new Date(),
      updatedAt: new Date(),
    },
    create: {
      reportType,
      periodStart,
      periodEnd,
      status: "MISSING",
      expectedAt,
      retryCount: 1,
      lastRetryAt: new Date(),
    },
});
 
   return record as WeeklyReportGenerationRecord;
 }
 
 /**
  * Record successful report generation
  */
 export async function recordGenerationSuccess(
   reportType: string,
   periodStart: Date,
 ): Promise<WeeklyReportGenerationRecord> {
   const record = await prisma.weeklyReportGeneration.update({
     where: {
       reportType_periodStart: {
         reportType,
         periodStart,
       },
     },
     data: {
       status: "SUCCESS",
       generatedAt: new Date(),
       updatedAt: new Date(),
     },
   });
 
   return record as WeeklyReportGenerationRecord;
 }
 
 /**
  * Record failed report generation
  */
 export async function recordGenerationFailure(
   reportType: string,
   periodStart: Date,
   errorMessage: string,
 ): Promise<WeeklyReportGenerationRecord> {
   const record = await prisma.weeklyReportGeneration.update({
     where: {
       reportType_periodStart: {
         reportType,
         periodStart,
       },
     },
     data: {
       status: "FAILED",
       errorMessage,
       generatedAt: new Date(), // Attempt was made
       updatedAt: new Date(),
     },
   });
 
   return record as WeeklyReportGenerationRecord;
 }

/**
 * Determine the status of a generation record based on current time
 */
function determineStatus(record: WeeklyReportGenerationRecord): ReportGenerationStatus {
  const now = new Date();

  if (record.status === "SUCCESS") {
    // Check if it was delayed (generated after expected time)
    if (record.generatedAt && record.generatedAt > record.expectedAt) {
      return "DELAYED";
    }
    return "SUCCESS";
  }

  if (record.status === "FAILED") {
    return "FAILED";
  }

  // Status is MISSING - check if we're past the expected time
  if (now > record.expectedAt) {
    return "MISSING";
  }

  return "MISSING"; // Not yet expected
}

/**
 * Get health check data for weekly report generations
 */
export async function getWeeklyReportHealth(
  reportType: string = "weekly-yield-report",
  periodsToCheck: number = 4,
): Promise<WeeklyReportHealthCheck> {
  const now = new Date();
  const records: WeeklyReportGenerationRecord[] = [];

  // Fetch records for the last N periods
  for (let i = 0; i < periodsToCheck; i++) {
    const periodStart = getWeeklyPeriodStart(-i);
    const periodEnd = getWeeklyPeriodEnd(periodStart);

    const record = await prisma.weeklyReportGeneration.findUnique({
      where: {
        reportType_periodStart: {
          reportType,
          periodStart,
        },
      },
    });

    if (record) {
      records.push(record as WeeklyReportGenerationRecord);
    } else {
      // Create a synthetic record for missing periods
      const expectedAt = getExpectedGenerationTime(periodStart);
      const status: ReportGenerationStatus = now > expectedAt ? "MISSING" : "MISSING";
      records.push({
        id: `synthetic-${reportType}-${periodStart.toISOString()}`,
        reportType,
        periodStart,
        periodEnd,
        status,
        expectedAt,
        generatedAt: null,
        errorMessage: null,
        retryCount: 0,
        lastRetryAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as WeeklyReportGenerationRecord);
    }
  }

  // Determine status for each record
  const periodsWithStatus = records.map((record) => ({
    ...record,
    computedStatus: determineStatus(record),
  }));

  // Current period is the most recent (index 0)
  const currentPeriod = periodsWithStatus[0];
  const previousPeriods = periodsWithStatus.slice(1);

  const summary = {
    totalPeriodsChecked: periodsWithStatus.length,
    successful: periodsWithStatus.filter((p) => p.computedStatus === "SUCCESS").length,
    missing: periodsWithStatus.filter((p) => p.computedStatus === "MISSING").length,
    delayed: periodsWithStatus.filter((p) => p.computedStatus === "DELAYED").length,
    failed: periodsWithStatus.filter((p) => p.computedStatus === "FAILED").length,
    needsCatchUp: periodsWithStatus.some(
      (p) => p.computedStatus === "MISSING" || p.computedStatus === "FAILED",
    ),
  };

  return {
    reportType,
    currentPeriod: {
      periodStart: currentPeriod.periodStart.toISOString().split("T")[0],
      periodEnd: currentPeriod.periodEnd.toISOString().split("T")[0],
      expectedAt: currentPeriod.expectedAt.toISOString(),
      status: currentPeriod.computedStatus,
      generatedAt: currentPeriod.generatedAt?.toISOString() ?? null,
      errorMessage: currentPeriod.errorMessage,
      retryCount: currentPeriod.retryCount,
    },
    previousPeriods: previousPeriods.map((p) => ({
      periodStart: p.periodStart.toISOString().split("T")[0],
      periodEnd: p.periodEnd.toISOString().split("T")[0],
      expectedAt: p.expectedAt.toISOString(),
      status: p.computedStatus,
      generatedAt: p.generatedAt?.toISOString() ?? null,
      errorMessage: p.errorMessage,
      retryCount: p.retryCount,
    })),
    summary,
  };
}

/**
 * Get periods that need catch-up generation (MISSING or FAILED)
 */
export async function getPeriodsNeedingCatchUp(
  reportType: string = "weekly-yield-report",
  maxPeriods: number = 4,
): Promise<Array<{ periodStart: Date; periodEnd: Date; status: ReportGenerationStatus }>> {
  const health = await getWeeklyReportHealth(reportType, maxPeriods);
  const catchUpPeriods: Array<{ periodStart: Date; periodEnd: Date; status: ReportGenerationStatus }> = [];

  // Check current period
  if (health.currentPeriod.status === "MISSING" || health.currentPeriod.status === "FAILED") {
    catchUpPeriods.push({
      periodStart: new Date(health.currentPeriod.periodStart),
      periodEnd: new Date(health.currentPeriod.periodEnd),
      status: health.currentPeriod.status,
    });
  }

  // Check previous periods
  for (const period of health.previousPeriods) {
    if (period.status === "MISSING" || period.status === "FAILED") {
      catchUpPeriods.push({
        periodStart: new Date(period.periodStart),
        periodEnd: new Date(period.periodEnd),
        status: period.status,
      });
    }
  }

  return catchUpPeriods;
}

/**
 * Generate catch-up reports for missed periods
 */
export async function generateCatchUpReports(
  reportType: string = "weekly-yield-report",
  maxPeriods: number = 4,
): Promise<Array<{ periodStart: Date; periodEnd: Date; success: boolean; error?: string }>> {
  const catchUpPeriods = await getPeriodsNeedingCatchUp(reportType, maxPeriods);
  const results: Array<{ periodStart: Date; periodEnd: Date; success: boolean; error?: string }> = [];

  for (const period of catchUpPeriods) {
    try {
      // Record attempt
      await recordGenerationAttempt(reportType, period.periodStart, period.periodEnd);

      // Generate reports for this period
      // In production, this would generate actual reports for the specific period
      const users = await getSubscribedUsers();
      const reports: WeeklyYieldReport[] = [];

      for (const user of users) {
        if (!user.subscribed) continue;

        try {
          const vaultYields = await getUserVaultYields();
          const report = calculateWeeklyYieldReport(
            user,
            vaultYields,
            period.periodStart,
            period.periodEnd,
          );
          reports.push(report);
        } catch (error) {
          console.error(
            `Failed to generate catch-up report for user ${user.userId} (period ${period.periodStart.toISOString()}):`,
            error,
          );
        }
      }

      // Record success
      await recordGenerationSuccess(reportType, period.periodStart);

      results.push({
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        success: true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      await recordGenerationFailure(reportType, period.periodStart, errorMessage);

      results.push({
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        success: false,
        error: errorMessage,
      });
    }
  }

  return results;
}

/**
 * Run the weekly report generation with tracking
 * This is the main entry point that should be called by the job scheduler
 */
export async function runWeeklyReportGenerationWithTracking(
  reportType: string = "weekly-yield-report",
): Promise<{
  success: boolean;
  reportsGenerated: number;
  currentPeriodStatus: ReportGenerationStatus;
  catchUpResults: Array<{ periodStart: Date; periodEnd: Date; success: boolean; error?: string }>;
  error?: string;
}> {
  const now = new Date();
  const periodStart = getWeeklyPeriodStart(0);
  const periodEnd = getWeeklyPeriodEnd(periodStart);
  const expectedAt = getExpectedGenerationTime(periodStart);

  const isDelayed = now > expectedAt;

  try {
    // Record attempt for current period
    await recordGenerationAttempt(reportType, periodStart, periodEnd);

    // Generate reports for current period
    const reports = await generateWeeklyYieldReports();

    // Record success
    await recordGenerationSuccess(reportType, periodStart);

    // Also run catch-up for any missed periods
    const catchUpResults = await generateCatchUpReports(reportType);

    return {
      success: true,
      reportsGenerated: reports.length,
      currentPeriodStatus: isDelayed ? "DELAYED" : "SUCCESS",
      catchUpResults,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await recordGenerationFailure(reportType, periodStart, errorMessage);

    return {
      success: false,
      reportsGenerated: 0,
      currentPeriodStatus: "FAILED",
      catchUpResults: [],
      error: errorMessage,
    };
  }
}
