import {
  validateBacktestRequest,
  BacktestValidationResult,
  BacktestRequest,
  SUPPORTED_BACKTEST_INTERVALS,
} from "../backtestService";

describe("BacktestService Validation", () => {
  describe("validateBacktestRequest", () => {
    it("should accept valid backtest request", () => {
      const request: BacktestRequest = {
        vaultContractId: "VAULT_123",
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        depositAmount: BigInt(1000000),
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should accept valid backtest request with supported interval string", () => {
      const request: BacktestRequest = {
        vaultContractId: "VAULT_123",
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        depositAmount: BigInt(1000000),
        interval: "monthly",
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should accept valid backtest request with supported interval shorthand and numeric days", () => {
      for (const interval of ["1d", "7d", "14d", "30d", "daily", "weekly", 14, 30]) {
        const request: BacktestRequest = {
          vaultContractId: "VAULT_123",
          startDate: "2024-01-01",
          endDate: "2024-12-31",
          depositAmount: BigInt(1000000),
          interval: interval as any,
        };

        const result = validateBacktestRequest(request);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }
    });

    it("should reject missing required fields", () => {
      const request = {
        vaultContractId: "VAULT_123",
        // missing startDate, endDate, depositAmount
      } as unknown as BacktestRequest;

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(
        result.errors.some((e) => e.code === "FIELD_REQUIRED"),
      ).toBe(true);
    });

    it("should reject empty vault contract ID", () => {
      const request: BacktestRequest = {
        vaultContractId: "",
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        depositAmount: BigInt(1000000),
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === "INVALID_VAULT_ID")).toBe(
        true,
      );
    });

    it("should reject invalid date format", () => {
      const request: BacktestRequest = {
        vaultContractId: "VAULT_123",
        startDate: "invalid-date",
        endDate: "2024-12-31",
        depositAmount: BigInt(1000000),
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((e) => e.code === "INVALID_DATE_FORMAT"),
      ).toBe(true);
    });

    it("should reject inverted date window (start date > end date)", () => {
      const request: BacktestRequest = {
        vaultContractId: "VAULT_123",
        startDate: "2024-12-31",
        endDate: "2024-01-01",
        depositAmount: BigInt(1000000),
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((e) => e.code === "INVALID_DATE_ORDER"),
      ).toBe(true);
    });

    it("should reject zero-length date window (same start and end date)", () => {
      const request: BacktestRequest = {
        vaultContractId: "VAULT_123",
        startDate: "2024-01-01",
        endDate: "2024-01-01",
        depositAmount: BigInt(1000000),
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((e) => e.code === "ZERO_LENGTH_WINDOW"),
      ).toBe(true);
      expect(
        result.errors.some((e) => e.code === "INVALID_DATE_ORDER"),
      ).toBe(true);
    });

    it("should reject unsupported interval string value", () => {
      const request: BacktestRequest = {
        vaultContractId: "VAULT_123",
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        depositAmount: BigInt(1000000),
        interval: "hourly" as any,
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((e) => e.code === "UNSUPPORTED_INTERVAL"),
      ).toBe(true);
      expect(
        result.errors.find((e) => e.code === "UNSUPPORTED_INTERVAL")?.message,
      ).toContain("hourly");
    });

    it("should reject non-positive or non-integer numeric intervals", () => {
      for (const invalidInterval of [0, -5, 3.14, NaN, Infinity]) {
        const request: BacktestRequest = {
          vaultContractId: "VAULT_123",
          startDate: "2024-01-01",
          endDate: "2024-12-31",
          depositAmount: BigInt(1000000),
          interval: invalidInterval as any,
        };

        const result = validateBacktestRequest(request);
        expect(result.isValid).toBe(false);
        expect(
          result.errors.some((e) => e.code === "UNSUPPORTED_INTERVAL"),
        ).toBe(true);
      }
    });

    it("should reject interval that exceeds the backtest date window duration", () => {
      const request: BacktestRequest = {
        vaultContractId: "VAULT_123",
        startDate: "2024-01-01",
        endDate: "2024-01-07", // 6-day window
        depositAmount: BigInt(1000000),
        interval: "monthly", // 30 days
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((e) => e.code === "UNSUPPORTED_INTERVAL_WINDOW"),
      ).toBe(true);
    });

    it("should reject future dates", () => {
      const future = new Date();
      future.setFullYear(future.getFullYear() + 1);
      const futureStr = future.toISOString().split("T")[0];

      const request: BacktestRequest = {
        vaultContractId: "VAULT_123",
        startDate: futureStr,
        endDate: futureStr,
        depositAmount: BigInt(1000000),
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === "DATE_IN_FUTURE")).toBe(
        true,
      );
    });

    it("should reject date range exceeding 2 years", () => {
      const request: BacktestRequest = {
        vaultContractId: "VAULT_123",
        startDate: "2020-01-01",
        endDate: "2024-01-01", // 4 years
        depositAmount: BigInt(1000000),
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((e) => e.code === "DATE_WINDOW_TOO_LARGE"),
      ).toBe(true);
    });

    it("should reject zero or negative deposit amount", () => {
      const request: BacktestRequest = {
        vaultContractId: "VAULT_123",
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        depositAmount: BigInt(0),
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((e) => e.code === "INVALID_DEPOSIT_AMOUNT"),
      ).toBe(true);
    });

    it("should provide specific error message for each failure", () => {
      const request: BacktestRequest = {
        vaultContractId: "",
        startDate: "2024-12-31",
        endDate: "2024-01-01",
        depositAmount: BigInt(0),
      };

      const result = validateBacktestRequest(request);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every((e) => e.message)).toBe(true);
      expect(result.errors.every((e) => e.code)).toBe(true);
    });

    it("should handle edge case: very small date window (1 day)", () => {
      const request: BacktestRequest = {
        vaultContractId: "VAULT_123",
        startDate: "2024-01-01",
        endDate: "2024-01-02",
        depositAmount: BigInt(1000000),
      };

      const result = validateBacktestRequest(request);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
