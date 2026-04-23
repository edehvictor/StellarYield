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
} from "../services/weeklyYieldReportService";
import { renderWeeklyYieldReport } from "../templates/weeklyYieldReportTemplate";

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
