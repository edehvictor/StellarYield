/**
 * Weekly Yield Report Service
 * Generates and manages weekly yield reports for users
 */

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
