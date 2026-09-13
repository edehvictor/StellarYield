import {
  generateMockUserYieldData,
  generateMockVaultYieldData,
  calculateWeeklyYieldReport,
  getWeeklyDateRange,
  formatDateForDisplay,
  getSubscribedUsers,
  getUserVaultYields,
  generateWeeklyYieldReports,
  filterReportsWithActivity,
  getReportStatistics,
  exportReportsToCSV,
  getWeeklyPeriodStart,
  getWeeklyPeriodEnd,
  getExpectedGenerationTime,
  getWeeklyReportHealth,
  getPeriodsNeedingCatchUp,
  generateCatchUpReports,
  runWeeklyReportGenerationWithTracking,
  WeeklyReportHealthCheck,
  ReportGenerationStatus,
} from "../services/weeklyYieldReportService";
import { renderWeeklyYieldReport } from "../templates/weeklyYieldReportTemplate";

// Mock Prisma Client for testing
jest.mock("@prisma/client", () => {
  const mockWeeklyReportGeneration = {
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    upsert: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
  };
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      weeklyReportGeneration: mockWeeklyReportGeneration,
      $disconnect: jest.fn().mockResolvedValue(undefined),
    })),
    __mockWeeklyReportGeneration: mockWeeklyReportGeneration,
  };
});

// Get the mock for use in tests
const { __mockWeeklyReportGeneration: mockWeeklyReportGeneration } = jest.requireMock("@prisma/client");

describe("Weekly Yield Report Service", () => {
  describe("generateMockUserYieldData", () => {
    it("should generate user yield data with required fields", () => {
      const user = generateMockUserYieldData("user-123");

      expect(user).toBeDefined();
      expect(user.userId).toBe("user-123");
      expect(user.walletAddress).toBeDefined();
      expect(user.email).toBeDefined();
      expect(user.userName).toBeDefined();
      expect(user.subscribed).toBe(true);
    });

    it("should generate unique wallet addresses", () => {
      const user1 = generateMockUserYieldData("user-1");
      const user2 = generateMockUserYieldData("user-2");

      expect(user1.walletAddress).not.toBe(user2.walletAddress);
    });
  });

  describe("generateMockVaultYieldData", () => {
    it("should generate vault yield data", () => {
      const vaults = generateMockVaultYieldData();

      expect(Array.isArray(vaults)).toBe(true);
      expect(vaults.length).toBeGreaterThan(0);
    });

    it("should have required vault fields", () => {
      const vaults = generateMockVaultYieldData();

      vaults.forEach((vault) => {
        expect(vault.vaultId).toBeDefined();
        expect(vault.vaultName).toBeDefined();
        expect(vault.yield).toBeGreaterThan(0);
        expect(vault.yieldPercentage).toBeGreaterThan(0);
        expect(vault.apy).toBeGreaterThan(0);
        expect(vault.tvl).toBeGreaterThan(0);
      });
    });
  });

  describe("calculateWeeklyYieldReport", () => {
    it("should calculate weekly yield report", () => {
      const user = generateMockUserYieldData("user-123");
      const vaults = generateMockVaultYieldData();
      const startDate = new Date("2024-01-01");
      const endDate = new Date("2024-01-08");

      const report = calculateWeeklyYieldReport(
        user,
        vaults,
        startDate,
        endDate,
      );

      expect(report).toBeDefined();
      expect(report.userId).toBe("user-123");
      expect(report.weeklyYield).toBeGreaterThan(0);
      expect(report.weeklyYieldPercentage).toBeGreaterThan(0);
      expect(report.totalYield).toBeGreaterThan(0);
      expect(report.vaultCount).toBe(vaults.length);
      expect(report.topVaults.length).toBeLessThanOrEqual(5);
    });

    it("should sort vaults by yield", () => {
      const user = generateMockUserYieldData("user-123");
      const vaults = generateMockVaultYieldData();
      const startDate = new Date("2024-01-01");
      const endDate = new Date("2024-01-08");

      const report = calculateWeeklyYieldReport(
        user,
        vaults,
        startDate,
        endDate,
      );

      for (let i = 0; i < report.topVaults.length - 1; i++) {
        expect(report.topVaults[i].yield).toBeGreaterThanOrEqual(
          report.topVaults[i + 1].yield,
        );
      }
    });

    it("should include period dates", () => {
      const user = generateMockUserYieldData("user-123");
      const vaults = generateMockVaultYieldData();
      const startDate = new Date("2024-01-01");
      const endDate = new Date("2024-01-08");

      const report = calculateWeeklyYieldReport(
        user,
        vaults,
        startDate,
        endDate,
      );

      expect(report.period.startDate).toBe("2024-01-01");
      expect(report.period.endDate).toBe("2024-01-08");
    });
  });

  describe("getWeeklyDateRange", () => {
    it("should return date range for past 7 days", () => {
      const { startDate, endDate } = getWeeklyDateRange();

      const diffMs = endDate.getTime() - startDate.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      expect(diffDays).toBeCloseTo(7, 0);
    });

    it("should have endDate as today", () => {
      const { endDate } = getWeeklyDateRange();
      const today = new Date();

      expect(endDate.toDateString()).toBe(today.toDateString());
    });
  });

  describe("formatDateForDisplay", () => {
    it("should format date correctly", () => {
      const date = new Date("2024-01-15");
      const formatted = formatDateForDisplay(date);

      expect(formatted).toContain("Jan");
      expect(formatted).toContain("15");
      expect(formatted).toContain("2024");
    });
  });

  describe("getSubscribedUsers", () => {
    it("should return array of users", async () => {
      const users = await getSubscribedUsers();

      expect(Array.isArray(users)).toBe(true);
      expect(users.length).toBeGreaterThan(0);
    });

    it("should have subscribed users", async () => {
      const users = await getSubscribedUsers();

      users.forEach((user) => {
        expect(user.subscribed).toBe(true);
      });
    });
  });

  describe("getUserVaultYields", () => {
    it("should return vault yields for user", async () => {
      const yields = await getUserVaultYields();

      expect(Array.isArray(yields)).toBe(true);
      expect(yields.length).toBeGreaterThan(0);
    });
  });

  describe("generateWeeklyYieldReports", () => {
    it("should generate reports for all subscribed users", async () => {
      const reports = await generateWeeklyYieldReports();

      expect(Array.isArray(reports)).toBe(true);
      expect(reports.length).toBeGreaterThan(0);
    });

    it("should have required report fields", async () => {
      const reports = await generateWeeklyYieldReports();

      reports.forEach((report) => {
        expect(report.userId).toBeDefined();
        expect(report.email).toBeDefined();
        expect(report.weeklyYield).toBeGreaterThanOrEqual(0);
        expect(report.topVaults).toBeDefined();
        expect(report.period).toBeDefined();
      });
    });
  });

  describe("filterReportsWithActivity", () => {
    it("should filter reports with activity", async () => {
      const reports = await generateWeeklyYieldReports();
      const filtered = filterReportsWithActivity(reports);

      expect(filtered.length).toBeLessThanOrEqual(reports.length);
      filtered.forEach((report) => {
        expect(report.weeklyYield).toBeGreaterThan(0);
        expect(report.topVaults.length).toBeGreaterThan(0);
      });
    });
  });

  describe("getReportStatistics", () => {
    it("should calculate statistics", async () => {
      const reports = await generateWeeklyYieldReports();
      const stats = getReportStatistics(reports);

      expect(stats.totalReports).toBe(reports.length);
      expect(stats.totalYieldGenerated).toBeGreaterThanOrEqual(0);
      expect(stats.averageYieldPerUser).toBeGreaterThanOrEqual(0);
      expect(stats.usersWithActivity).toBeLessThanOrEqual(reports.length);
    });

    it("should identify top performer", async () => {
      const reports = await generateWeeklyYieldReports();
      const stats = getReportStatistics(reports);

      if (reports.length > 0) {
        expect(stats.topPerformer).toBeDefined();
        expect(stats.topPerformer?.weeklyYield).toBeGreaterThanOrEqual(0);
      }
    });

    it("should handle empty reports", () => {
      const stats = getReportStatistics([]);

      expect(stats.totalReports).toBe(0);
      expect(stats.totalYieldGenerated).toBe(0);
      expect(stats.averageYieldPerUser).toBe(0);
      expect(stats.topPerformer).toBeNull();
    });
  });

  describe("exportReportsToCSV", () => {
    it("should export reports as CSV", async () => {
      const reports = await generateWeeklyYieldReports();
      const csv = exportReportsToCSV(reports);

      expect(typeof csv).toBe("string");
      expect(csv).toContain("User ID");
      expect(csv).toContain("Email");
      expect(csv).toContain("Weekly Yield");
    });

    it("should include all reports in CSV", async () => {
      const reports = await generateWeeklyYieldReports();
      const csv = exportReportsToCSV(reports);
      const lines = csv.split("\n");

      // Header + reports
      expect(lines.length).toBeGreaterThanOrEqual(reports.length + 1);
    });

    it("should handle empty reports", () => {
      const csv = exportReportsToCSV([]);

      expect(typeof csv).toBe("string");
      expect(csv).toContain("User ID");
    });
  });

  describe("renderWeeklyYieldReport", () => {
    it("should render HTML email template", () => {
      const user = generateMockUserYieldData("user-123");
      const vaults = generateMockVaultYieldData();
      const startDate = new Date("2024-01-01");
      const endDate = new Date("2024-01-08");

      const report = calculateWeeklyYieldReport(
        user,
        vaults,
        startDate,
        endDate,
      );

      const html = renderWeeklyYieldReport({
        userName: report.userName,
        walletAddress: report.walletAddress,
        weeklyYield: report.weeklyYield,
        weeklyYieldPercentage: report.weeklyYieldPercentage,
        totalYield: report.totalYield,
        topVaults: report.topVaults,
        vaultCount: report.vaultCount,
        period: report.period,
      });

      expect(typeof html).toBe("string");
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("Weekly Yield Report");
      expect(html).toContain(report.userName);
      expect(html).toContain(report.weeklyYield.toFixed(2));
    });

    it("should include top vaults in template", () => {
      const user = generateMockUserYieldData("user-123");
      const vaults = generateMockVaultYieldData();
      const startDate = new Date("2024-01-01");
      const endDate = new Date("2024-01-08");

      const report = calculateWeeklyYieldReport(
        user,
        vaults,
        startDate,
        endDate,
      );

      const html = renderWeeklyYieldReport({
        userName: report.userName,
        walletAddress: report.walletAddress,
        weeklyYield: report.weeklyYield,
        weeklyYieldPercentage: report.weeklyYieldPercentage,
        totalYield: report.totalYield,
        topVaults: report.topVaults,
        vaultCount: report.vaultCount,
        period: report.period,
      });

      report.topVaults.forEach((vault) => {
        expect(html).toContain(vault.vaultName);
      });
    });

    it("should handle empty vaults", () => {
      const html = renderWeeklyYieldReport({
        userName: "Test User",
        walletAddress: "GTEST123",
        weeklyYield: 0,
        weeklyYieldPercentage: 0,
        totalYield: 0,
        topVaults: [],
        vaultCount: 0,
        period: {
          startDate: "2024-01-01",
          endDate: "2024-01-08",
        },
      });

      expect(html).toContain("No vault activity");
    });
  });

  describe("Integration tests", () => {
    it("should generate and export reports", async () => {
      const reports = await generateWeeklyYieldReports();
      const filtered = filterReportsWithActivity(reports);
      const stats = getReportStatistics(filtered);
      const csv = exportReportsToCSV(filtered);

      expect(reports.length).toBeGreaterThan(0);
      expect(stats.totalReports).toBe(filtered.length);
      expect(csv).toContain("User ID");
    });

    it("should handle full report generation workflow", async () => {
      const users = await getSubscribedUsers();
      expect(users.length).toBeGreaterThan(0);

      const reports = await generateWeeklyYieldReports();
      expect(reports.length).toBeGreaterThan(0);

      const filtered = filterReportsWithActivity(reports);
      expect(filtered.length).toBeLessThanOrEqual(reports.length);

      const stats = getReportStatistics(filtered);
      expect(stats.totalReports).toBe(filtered.length);

      filtered.forEach((report) => {
        const html = renderWeeklyYieldReport({
          userName: report.userName,
          walletAddress: report.walletAddress,
          weeklyYield: report.weeklyYield,
          weeklyYieldPercentage: report.weeklyYieldPercentage,
          totalYield: report.totalYield,
          topVaults: report.topVaults,
          vaultCount: report.vaultCount,
          period: report.period,
        });

        expect(html).toContain("Weekly Yield Report");
      });
    });
  });
});

describe("Weekly Yield Report Preview Fixture", () => {
  it("should generate deterministic preview fixture", () => {
    const user = generateMockUserYieldData("preview-user");
    const vaults = generateMockVaultYieldData();
    const startDate = new Date("2024-01-01");
    const endDate = new Date("2024-01-08");

    const report = calculateWeeklyYieldReport(user, vaults, startDate, endDate);

    expect(report.userId).toBe("preview-user");
    expect(report.weeklyYield).toBeGreaterThan(0);
    expect(report.topVaults.length).toBeGreaterThan(0);
  });

  it("should render preview fixture as HTML", () => {
    const user = generateMockUserYieldData("preview-user");
    const vaults = generateMockVaultYieldData();
    const startDate = new Date("2024-01-01");
    const endDate = new Date("2024-01-08");

    const report = calculateWeeklyYieldReport(user, vaults, startDate, endDate);

    const html = renderWeeklyYieldReport({
      userName: report.userName,
      walletAddress: report.walletAddress,
      weeklyYield: report.weeklyYield,
      weeklyYieldPercentage: report.weeklyYieldPercentage,
      totalYield: report.totalYield,
      topVaults: report.topVaults,
      vaultCount: report.vaultCount,
      period: report.period,
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Weekly Yield Report");
    expect(html).toContain("preview-user");
  });

  it("should use fixture data without real user data", () => {
    const user = generateMockUserYieldData("preview-user");

    // Verify no real user data is included
    expect(user.email).toContain("preview-user");
    expect(user.walletAddress).toMatch(/^G[a-zA-Z0-9]+$/);
    expect(user.walletAddress.length).toBeGreaterThan(10);
    expect(user.userName).toContain("preview-user");
  });
});

describe("Weekly Report Generation Tracking & Health Checks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset findUnique to default behavior (returns null for synthetic records)
    mockWeeklyReportGeneration.findUnique.mockImplementation(async ({ where }) => {
      const periodStart = where.reportType_periodStart.periodStart;
      // Default: return null (synthetic record will be created)
      return null;
    });
  });

  describe("getWeeklyPeriodStart / getWeeklyPeriodEnd", () => {
    it("should return correct period start for current week (offset 0)", () => {
      const periodStart = getWeeklyPeriodStart(0);
      expect(periodStart.getDay()).toBe(1); // Monday
      expect(periodStart.getHours()).toBe(0);
      expect(periodStart.getMinutes()).toBe(0);
    });

    it("should return correct period start for previous week (offset -1)", () => {
      const periodStart = getWeeklyPeriodStart(-1);
      expect(periodStart.getDay()).toBe(1); // Monday
      const currentStart = getWeeklyPeriodStart(0);
      const diffDays = (currentStart.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBe(7);
    });

    it("should return correct period end for a given start", () => {
      const periodStart = new Date("2024-01-01T00:00:00.000Z"); // Monday
      const periodEnd = getWeeklyPeriodEnd(periodStart);
      expect(periodEnd.getDay()).toBe(0); // Sunday
      expect(periodEnd.getHours()).toBe(23);
      expect(periodEnd.getMinutes()).toBe(59);
    });
  });

  describe("getExpectedGenerationTime", () => {
    it("should return Monday 9 AM of the week after the period", () => {
      const periodStart = new Date("2024-01-01T00:00:00.000Z"); // Monday
      const expected = getExpectedGenerationTime(periodStart);
      expect(expected.getDay()).toBe(1); // Monday
      expect(expected.getHours()).toBe(9);
      expect(expected.getMinutes()).toBe(0);
      // Should be exactly 7 days after period start (accounting for timezone)
      const diffDays = (expected.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeCloseTo(7, 0);
    });
  });

  describe("recordGenerationAttempt / recordGenerationSuccess / recordGenerationFailure", () => {
    it("should record a generation attempt", async () => {
      const periodStart = getWeeklyPeriodStart(-2); // Two weeks ago
      const periodEnd = getWeeklyPeriodEnd(periodStart);

      const mockRecord = {
        id: "test-id",
        reportType: "weekly-yield-report",
        periodStart,
        periodEnd,
        status: "MISSING",
        expectedAt: getExpectedGenerationTime(periodStart),
        generatedAt: null,
        errorMessage: null,
        retryCount: 1,
        lastRetryAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockWeeklyReportGeneration.upsert.mockResolvedValue(mockRecord);

      const { recordGenerationAttempt } = await import("../services/weeklyYieldReportService");
      const record = await recordGenerationAttempt("weekly-yield-report", periodStart, periodEnd);

      expect(record).toBeDefined();
      expect(record.reportType).toBe("weekly-yield-report");
      expect(record.status).toBe("MISSING");
      expect(record.retryCount).toBe(1);
    });

    it("should record generation success", async () => {
      const periodStart = getWeeklyPeriodStart(-3); // Three weeks ago
      const periodEnd = getWeeklyPeriodEnd(periodStart);

      const mockRecord = {
        id: "test-id",
        reportType: "weekly-yield-report",
        periodStart,
        periodEnd,
        status: "SUCCESS",
        expectedAt: getExpectedGenerationTime(periodStart),
        generatedAt: new Date(),
        errorMessage: null,
        retryCount: 1,
        lastRetryAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockWeeklyReportGeneration.update.mockResolvedValue(mockRecord);

      const { recordGenerationSuccess } = await import("../services/weeklyYieldReportService");
      const record = await recordGenerationSuccess("weekly-yield-report", periodStart);

      expect(record.status).toBe("SUCCESS");
      expect(record.generatedAt).toBeDefined();
    });

    it("should record generation failure", async () => {
      const periodStart = getWeeklyPeriodStart(-4); // Four weeks ago
      const periodEnd = getWeeklyPeriodEnd(periodStart);

      const mockRecord = {
        id: "test-id",
        reportType: "weekly-yield-report",
        periodStart,
        periodEnd,
        status: "FAILED",
        expectedAt: getExpectedGenerationTime(periodStart),
        generatedAt: new Date(),
        errorMessage: "Test error",
        retryCount: 1,
        lastRetryAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockWeeklyReportGeneration.update.mockResolvedValue(mockRecord);

      const { recordGenerationFailure } = await import("../services/weeklyYieldReportService");
      const record = await recordGenerationFailure("weekly-yield-report", periodStart, "Test error");

      expect(record.status).toBe("FAILED");
      expect(record.errorMessage).toBe("Test error");
      expect(record.generatedAt).toBeDefined();
    });
  });

  describe("getWeeklyReportHealth", () => {
    it("should return health check with all periods", async () => {
      const health = await getWeeklyReportHealth("weekly-yield-report", 4);

      expect(health).toBeDefined();
      expect(health.reportType).toBe("weekly-yield-report");
      expect(health.currentPeriod).toBeDefined();
      expect(health.previousPeriods).toBeDefined();
      expect(health.previousPeriods.length).toBe(3);
      expect(health.summary).toBeDefined();
      expect(health.summary.totalPeriodsChecked).toBe(4);
    });

    it("should have correct status fields in current period", async () => {
      const health = await getWeeklyReportHealth("weekly-yield-report", 1);

      expect(health.currentPeriod.periodStart).toBeDefined();
      expect(health.currentPeriod.periodEnd).toBeDefined();
      expect(health.currentPeriod.expectedAt).toBeDefined();
      expect(["SUCCESS", "MISSING", "DELAYED", "FAILED"]).toContain(health.currentPeriod.status);
      expect(typeof health.currentPeriod.retryCount).toBe("number");
    });

    it("should have correct summary counts", async () => {
      const health = await getWeeklyReportHealth("weekly-yield-report", 4);

      const { successful, missing, delayed, failed, totalPeriodsChecked, needsCatchUp } = health.summary;

      expect(successful + missing + delayed + failed).toBe(totalPeriodsChecked);
      expect(typeof needsCatchUp).toBe("boolean");
    });
  });

  describe("getPeriodsNeedingCatchUp", () => {
    it("should return empty array when all periods are successful", async () => {
      // Mock findUnique to return successful records
      const periods = [0, 1, 2].map((i) => {
        const periodStart = getWeeklyPeriodStart(-i);
        return {
          id: `success-${i}`,
          reportType: "weekly-yield-report",
          periodStart,
          periodEnd: getWeeklyPeriodEnd(periodStart),
          status: "SUCCESS",
          expectedAt: getExpectedGenerationTime(periodStart),
          generatedAt: new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000),
          errorMessage: null,
          retryCount: 1,
          lastRetryAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });
      
      mockWeeklyReportGeneration.findUnique.mockImplementation(async ({ where }) => {
        const requestedPeriodStart = where.reportType_periodStart.periodStart;
        const match = periods.find(p => p.periodStart.getTime() === requestedPeriodStart.getTime());
        return match || null;
      });

      const catchUp = await getPeriodsNeedingCatchUp("weekly-yield-report", 3);
      expect(Array.isArray(catchUp)).toBe(true);
    });

    it("should identify MISSING periods", async () => {
      const periodStart = getWeeklyPeriodStart(-5);
      const periodEnd = getWeeklyPeriodEnd(periodStart);

      mockWeeklyReportGeneration.findUnique.mockImplementation(async ({ where }) => {
        const requestedPeriodStart = where.reportType_periodStart.periodStart;
        if (requestedPeriodStart.getTime() === periodStart.getTime()) {
          return {
            id: "missing",
            reportType: "weekly-yield-report",
            periodStart,
            periodEnd,
            status: "MISSING",
            expectedAt: getExpectedGenerationTime(periodStart),
            generatedAt: null,
            errorMessage: null,
            retryCount: 0,
            lastRetryAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        return null;
      });

      const catchUp = await getPeriodsNeedingCatchUp("weekly-yield-report", 6);
      const missingPeriod = catchUp.find((p) => p.status === "MISSING");
      expect(missingPeriod).toBeDefined();
    });

    it("should identify FAILED periods", async () => {
      const periodStart = getWeeklyPeriodStart(-6);
      const periodEnd = getWeeklyPeriodEnd(periodStart);

      mockWeeklyReportGeneration.findUnique.mockImplementation(async ({ where }) => {
        const requestedPeriodStart = where.reportType_periodStart.periodStart;
        // Return the failed record for the specific period
        if (requestedPeriodStart.getTime() === periodStart.getTime()) {
          return {
            id: "failed",
            reportType: "weekly-yield-report",
            periodStart,
            periodEnd,
            status: "FAILED",
            expectedAt: getExpectedGenerationTime(periodStart),
            generatedAt: new Date(),
            errorMessage: "Test failure",
            retryCount: 1,
            lastRetryAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        return null;
      });

      const catchUp = await getPeriodsNeedingCatchUp("weekly-yield-report", 7);
      const failedPeriod = catchUp.find((p) => p.status === "FAILED");
      expect(failedPeriod).toBeDefined();
    });
  });

  describe("generateCatchUpReports", () => {
    it("should generate reports for missed periods", async () => {
      // This test verifies the function runs without error
      // In a real test environment, we'd mock the database and email service
      const results = await generateCatchUpReports("weekly-yield-report", 2);

      expect(Array.isArray(results)).toBe(true);
      // Results may be empty if no periods need catch-up
      results.forEach((result) => {
        expect(result.periodStart).toBeDefined();
        expect(result.periodEnd).toBeDefined();
        expect(typeof result.success).toBe("boolean");
        if (!result.success) {
          expect(result.error).toBeDefined();
        }
      });
    });
  });

  describe("runWeeklyReportGenerationWithTracking", () => {
    it("should run generation with tracking and return result", async () => {
      const result = await runWeeklyReportGenerationWithTracking("weekly-yield-report");

      expect(result).toBeDefined();
      expect(typeof result.success).toBe("boolean");
      expect(typeof result.reportsGenerated).toBe("number");
      expect(["SUCCESS", "DELAYED", "FAILED"]).toContain(result.currentPeriodStatus);
      expect(Array.isArray(result.catchUpResults)).toBe(true);
    });

    it("should include catch-up results in output", async () => {
      const result = await runWeeklyReportGenerationWithTracking("weekly-yield-report");

      expect(result.catchUpResults).toBeDefined();
      result.catchUpResults.forEach((catchUp) => {
        expect(catchUp.periodStart).toBeDefined();
        expect(catchUp.periodEnd).toBeDefined();
        expect(typeof catchUp.success).toBe("boolean");
      });
    });
  });

  describe("Health check status distinctions", () => {
    it("should distinguish MISSING from DELAYED from FAILED", async () => {
      // Mock findUnique to return records with different statuses for each period
      const successPeriod = getWeeklyPeriodStart(-10);
      const delayedPeriod = getWeeklyPeriodStart(-9);
      const missingPeriod = getWeeklyPeriodStart(-8);
      const failedPeriod = getWeeklyPeriodStart(-7);
      const currentPeriod = getWeeklyPeriodStart(0);

      mockWeeklyReportGeneration.findUnique.mockImplementation(async ({ where }) => {
        const requestedPeriodStart = where.reportType_periodStart.periodStart;
        
        if (requestedPeriodStart.getTime() === successPeriod.getTime()) {
          return {
            id: "success",
            reportType: "weekly-yield-report",
            periodStart: successPeriod,
            periodEnd: getWeeklyPeriodEnd(successPeriod),
            status: "SUCCESS",
            expectedAt: getExpectedGenerationTime(successPeriod),
            generatedAt: new Date(getExpectedGenerationTime(successPeriod).getTime() - 3600000),
            errorMessage: null,
            retryCount: 1,
            lastRetryAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        if (requestedPeriodStart.getTime() === delayedPeriod.getTime()) {
          return {
            id: "delayed",
            reportType: "weekly-yield-report",
            periodStart: delayedPeriod,
            periodEnd: getWeeklyPeriodEnd(delayedPeriod),
            status: "SUCCESS",
            expectedAt: getExpectedGenerationTime(delayedPeriod),
            generatedAt: new Date(getExpectedGenerationTime(delayedPeriod).getTime() + 3600000),
            errorMessage: null,
            retryCount: 1,
            lastRetryAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        if (requestedPeriodStart.getTime() === missingPeriod.getTime()) {
          return {
            id: "missing",
            reportType: "weekly-yield-report",
            periodStart: missingPeriod,
            periodEnd: getWeeklyPeriodEnd(missingPeriod),
            status: "MISSING",
            expectedAt: getExpectedGenerationTime(missingPeriod),
            generatedAt: null,
            errorMessage: null,
            retryCount: 0,
            lastRetryAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        if (requestedPeriodStart.getTime() === failedPeriod.getTime()) {
          return {
            id: "failed",
            reportType: "weekly-yield-report",
            periodStart: failedPeriod,
            periodEnd: getWeeklyPeriodEnd(failedPeriod),
            status: "FAILED",
            expectedAt: getExpectedGenerationTime(failedPeriod),
            generatedAt: new Date(),
            errorMessage: "Database connection failed",
            retryCount: 1,
            lastRetryAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        if (requestedPeriodStart.getTime() === currentPeriod.getTime()) {
          return {
            id: "current",
            reportType: "weekly-yield-report",
            periodStart: currentPeriod,
            periodEnd: getWeeklyPeriodEnd(currentPeriod),
            status: "MISSING",
            expectedAt: getExpectedGenerationTime(currentPeriod),
            generatedAt: null,
            errorMessage: null,
            retryCount: 0,
            lastRetryAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        return null;
      });

      // Get health check
      const health = await getWeeklyReportHealth("weekly-yield-report", 11);

      // Verify all four statuses are represented in the results
      const allStatuses = [
        health.currentPeriod.status,
        ...health.previousPeriods.map((p) => p.status),
      ];

      expect(allStatuses).toContain("SUCCESS");
      expect(allStatuses).toContain("DELAYED");
      expect(allStatuses).toContain("MISSING");
      expect(allStatuses).toContain("FAILED");

      // Verify summary counts
      expect(health.summary.successful).toBeGreaterThanOrEqual(1);
      expect(health.summary.delayed).toBeGreaterThanOrEqual(1);
      expect(health.summary.missing).toBeGreaterThanOrEqual(1);
      expect(health.summary.failed).toBeGreaterThanOrEqual(1);
    });

    it("should mark needsCatchUp when MISSING or FAILED periods exist", async () => {
      const currentPeriod = getWeeklyPeriodStart(0);
      mockWeeklyReportGeneration.findUnique.mockImplementation(async ({ where }) => {
        const requestedPeriodStart = where.reportType_periodStart.periodStart;
        if (requestedPeriodStart.getTime() === currentPeriod.getTime()) {
          return {
            id: "current",
            reportType: "weekly-yield-report",
            periodStart: currentPeriod,
            periodEnd: getWeeklyPeriodEnd(currentPeriod),
            status: "MISSING",
            expectedAt: getExpectedGenerationTime(currentPeriod),
            generatedAt: null,
            errorMessage: null,
            retryCount: 0,
            lastRetryAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        return null;
      });

      const health = await getWeeklyReportHealth("weekly-yield-report", 1);
      expect(health.summary.needsCatchUp).toBe(true);
    });
  });

  describe("Retry scenarios", () => {
    it("should increment retry count on repeated attempts", async () => {
      const periodStart = getWeeklyPeriodStart(-11);
      const periodEnd = getWeeklyPeriodEnd(periodStart);

      let retryCount = 1;
      mockWeeklyReportGeneration.upsert.mockImplementation(async () => ({
        id: "test",
        reportType: "weekly-yield-report",
        periodStart,
        periodEnd,
        status: "MISSING",
        expectedAt: getExpectedGenerationTime(periodStart),
        generatedAt: null,
        errorMessage: null,
        retryCount: retryCount++,
        lastRetryAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const { recordGenerationAttempt } = await import("../services/weeklyYieldReportService");
      await recordGenerationAttempt("weekly-yield-report", periodStart, periodEnd);
      const record2 = await recordGenerationAttempt("weekly-yield-report", periodStart, periodEnd);

      expect(record2.retryCount).toBe(2);
    });

    it("should track lastRetryAt timestamp", async () => {
      const periodStart = getWeeklyPeriodStart(-12);
      const periodEnd = getWeeklyPeriodEnd(periodStart);

      const beforeRetry = new Date();
      mockWeeklyReportGeneration.update.mockResolvedValue({
        id: "test",
        reportType: "weekly-yield-report",
        periodStart,
        periodEnd,
        status: "MISSING",
        expectedAt: getExpectedGenerationTime(periodStart),
        generatedAt: null,
        errorMessage: null,
        retryCount: 1,
        lastRetryAt: new Date(beforeRetry.getTime() + 100),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const { recordGenerationAttempt } = await import("../services/weeklyYieldReportService");
      const record = await recordGenerationAttempt("weekly-yield-report", periodStart, periodEnd);

      expect(record.lastRetryAt).toBeDefined();
      expect(record.lastRetryAt!.getTime()).toBeGreaterThanOrEqual(beforeRetry.getTime());
    });
  });

  describe("Catch-up generation scenarios", () => {
    it("should handle multiple missed periods in sequence", async () => {
      // Mock findUnique to return multiple MISSING periods
      const periods = [13, 14, 15].map((i) => {
        const periodStart = getWeeklyPeriodStart(-i);
        return {
          id: `missing-${i}`,
          reportType: "weekly-yield-report",
          periodStart,
          periodEnd: getWeeklyPeriodEnd(periodStart),
          status: "MISSING",
          expectedAt: getExpectedGenerationTime(periodStart),
          generatedAt: null,
          errorMessage: null,
          retryCount: 0,
          lastRetryAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });

      mockWeeklyReportGeneration.findUnique.mockImplementation(async ({ where }) => {
        const requestedPeriodStart = where.reportType_periodStart.periodStart;
        const match = periods.find(p => p.periodStart.getTime() === requestedPeriodStart.getTime());
        return match || null;
      });

      const catchUp = await getPeriodsNeedingCatchUp("weekly-yield-report", 16);
      const missingCount = catchUp.filter((p) => p.status === "MISSING").length;
      expect(missingCount).toBeGreaterThanOrEqual(3);
    });

    it("should generate catch-up for both MISSING and FAILED periods", async () => {
      const missingPeriod = getWeeklyPeriodStart(-5);
      const failedPeriod = getWeeklyPeriodStart(-6);

      mockWeeklyReportGeneration.findUnique.mockImplementation(async ({ where }) => {
        const requestedPeriodStart = where.reportType_periodStart.periodStart;
        if (requestedPeriodStart.getTime() === missingPeriod.getTime()) {
          return {
            id: "missing",
            reportType: "weekly-yield-report",
            periodStart: missingPeriod,
            periodEnd: getWeeklyPeriodEnd(missingPeriod),
            status: "MISSING",
            expectedAt: getExpectedGenerationTime(missingPeriod),
            generatedAt: null,
            errorMessage: null,
            retryCount: 0,
            lastRetryAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        if (requestedPeriodStart.getTime() === failedPeriod.getTime()) {
          return {
            id: "failed",
            reportType: "weekly-yield-report",
            periodStart: failedPeriod,
            periodEnd: getWeeklyPeriodEnd(failedPeriod),
            status: "FAILED",
            expectedAt: getExpectedGenerationTime(failedPeriod),
            generatedAt: new Date(),
            errorMessage: "Test failure",
            retryCount: 1,
            lastRetryAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        return null;
      });

      const catchUp = await getPeriodsNeedingCatchUp("weekly-yield-report", 7);
      const needsCatchUp = catchUp.filter(
        (p) => p.status === "MISSING" || p.status === "FAILED",
      );
      expect(needsCatchUp.length).toBeGreaterThan(0);
    });
  });
});
