import {
  createScheduledReportFilename,
  parseScheduledReportFilename,
  sanitizeFilenameSegment,
} from "../services/export/csvGenerator";

describe("Deterministic Scheduled Report Filenames (#1374)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, NODE_ENV: "production" };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("createScheduledReportFilename", () => {
    it("generates deterministic filename with periodStart and periodEnd range", () => {
      const filename = createScheduledReportFilename({
        reportType: "weekly-yield-reports",
        frequency: "weekly",
        periodStart: new Date("2026-05-18T00:00:00.000Z"),
        periodEnd: new Date("2026-05-24T23:59:59.999Z"),
        environment: "production",
        extension: "csv",
      });

      expect(filename).toBe(
        "stellaryield-weekly-yield-reports-weekly-production-2026-05-18-to-2026-05-24.csv",
      );
    });

    it("generates deterministic filename with single date", () => {
      const filename = createScheduledReportFilename({
        reportType: "daily-summary",
        frequency: "daily",
        periodStart: "2026-06-01",
        environment: "testnet",
        extension: "json",
      });

      expect(filename).toBe(
        "stellaryield-daily-summary-daily-testnet-2026-06-01.json",
      );
    });

    it("handles timestamp numbers for period dates", () => {
      const startMs = Date.UTC(2026, 0, 15);
      const endMs = Date.UTC(2026, 0, 22);

      const filename = createScheduledReportFilename({
        reportType: "audit-log",
        periodStart: startMs,
        periodEnd: endMs,
        environment: "testnet",
      });

      expect(filename).toBe(
        "stellaryield-audit-log-testnet-2026-01-15-to-2026-01-22.csv",
      );
    });

    it("falls back gracefully when dates are omitted or invalid", () => {
      const today = new Date().toISOString().split("T")[0];
      const filename = createScheduledReportFilename({
        reportType: "vault-health",
        periodStart: "invalid-date",
        environment: "mainnet",
      });

      expect(filename).toBe(`stellaryield-vault-health-mainnet-${today}.csv`);
    });

    it("sanitizes unsafe characters, path traversal attempts, and whitespace", () => {
      const filename = createScheduledReportFilename({
        reportType: "../../dangerous/../payload :&",
        frequency: "bi-weekly / test",
        environment: "dev/staging..test",
        periodStart: "2026-05-01",
        extension: "csv.exe",
      });

      expect(filename).not.toContain("..");
      expect(filename).not.toContain("/");
      expect(filename).not.toContain(" ");
      expect(filename).not.toContain(":");
      expect(filename).toMatch(/\.csv\.exe$/);
    });

    it("is strictly deterministic: identical inputs yield identical outputs", () => {
      const options = {
        reportType: "quarterly-rebalance",
        frequency: "quarterly",
        periodStart: new Date("2026-01-01T00:00:00.000Z"),
        periodEnd: new Date("2026-03-31T00:00:00.000Z"),
        environment: "production",
      };

      const run1 = createScheduledReportFilename(options);
      const run2 = createScheduledReportFilename(options);
      const run3 = createScheduledReportFilename(options);

      expect(run1).toBe(run2);
      expect(run2).toBe(run3);
    });
  });

  describe("parseScheduledReportFilename", () => {
    it("parses valid report filenames back to metadata components", () => {
      const parsed = parseScheduledReportFilename(
        "stellaryield-weekly-yield-report-weekly-production-2026-05-18-to-2026-05-24.csv",
      );

      expect(parsed).not.toBeNull();
      expect(parsed?.prefix).toBe("stellaryield");
      expect(parsed?.reportType).toBe("weekly");
      expect(parsed?.extension).toBe("csv");
    });

    it("returns null for malformed filenames", () => {
      expect(parseScheduledReportFilename("invalid-name.txt")).toBeNull();
      expect(parseScheduledReportFilename("")).toBeNull();
    });
  });
});
