/**
 * Issue #478: Improve Backtest Date Range Validation Messages
 *
 * Enhanced backtest service with comprehensive validation for date ranges,
 * future dates, and overly long windows.
 */

import {
  validateDateRange,
  validateNumericRange,
  validateRequired,
  ValidationException,
  collectValidationErrors,
} from "../utils/validationHelper";

// Constants
const MAX_BACKTEST_WINDOW_DAYS = 730; // 2 years
const MIN_BACKTEST_WINDOW_DAYS = 1;

export type BacktestInterval =
  | "1d"
  | "7d"
  | "14d"
  | "30d"
  | "90d"
  | "365d"
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "yearly";

export const SUPPORTED_BACKTEST_INTERVALS: readonly BacktestInterval[] = [
  "1d",
  "7d",
  "14d",
  "30d",
  "90d",
  "365d",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;

export const INTERVAL_DAYS_MAP: Record<BacktestInterval, number> = {
  "1d": 1,
  daily: 1,
  "7d": 7,
  weekly: 7,
  "14d": 14,
  "30d": 30,
  monthly: 30,
  "90d": 90,
  quarterly: 90,
  "365d": 365,
  yearly: 365,
};

export interface BacktestRequest {
  vaultContractId: string;
  startDate: string;
  endDate: string;
  depositAmount: bigint | number | string;
  interval?: BacktestInterval | string | number;
}

export interface DailySnapshot {
  date: string;
  apy: number;
  equityValue: bigint | number | string;
}

export interface BacktestResult {
  vaultContractId: string;
  startDate: string;
  endDate: string;
  initialDeposit: bigint | number | string;
  finalValue: bigint | number | string;
  totalReturn: number;
  snapshots: DailySnapshot[];
}

export interface BacktestValidationResult {
  isValid: boolean;
  errors: Array<{
    code: string;
    message: string;
    field?: string;
  }>;
}

/**
 * Validates backtest request parameters with detailed error reporting.
 * Returns specific error codes for each validation failure.
 *
 * @returns BacktestValidationResult with specific error codes and messages
 */
export function validateBacktestRequest(
  request: BacktestRequest,
): BacktestValidationResult {
  const errors: Array<{ code: string; message: string; field?: string }> = [];

  try {
    // Required fields validation
    const requiredErrors = validateRequired(request as unknown as Record<string, unknown>, [
      "vaultContractId",
      "startDate",
      "endDate",
      "depositAmount",
    ]);

    errors.push(
      ...requiredErrors.map((e) => ({
        code: e.details?.field === "vaultContractId" ? "INVALID_VAULT_ID" : e.code,
        message: e.details?.field === "vaultContractId" ? "Vault contract ID must be a non-empty string" : e.message,
        field: e.details?.field as string,
      })),
    );

    // Early exit if required fields are missing
    if (errors.length > 0) {
      return { isValid: false, errors };
    }

    // Parse dates
    let startDate: Date;
    let endDate: Date;

    try {
      startDate = new Date(request.startDate);
      endDate = new Date(request.endDate);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw new Error("Invalid date format");
      }
    } catch {
      errors.push({
        code: "INVALID_DATE_FORMAT",
        message: "Start and end dates must be valid ISO-8601 date strings",
        field: "dates",
      });
      return { isValid: false, errors };
    }

    // Date range validation
    const dateErrors = validateDateRange(startDate, endDate, {
      maxWindowDays: MAX_BACKTEST_WINDOW_DAYS,
      minWindowDays: MIN_BACKTEST_WINDOW_DAYS,
      allowFutureDates: false,
    });

    errors.push(
      ...dateErrors.map((e) => ({
        code: e.code,
        message: e.message,
      })),
    );

    // Interval validation (if provided)
    if (request.interval !== undefined && request.interval !== null && request.interval !== "") {
      let intervalDays: number | null = null;

      if (typeof request.interval === "number") {
        if (!Number.isFinite(request.interval) || request.interval <= 0 || !Number.isInteger(request.interval)) {
          errors.push({
            code: "UNSUPPORTED_INTERVAL",
            message: `Interval must be a positive integer representing days (got ${request.interval})`,
            field: "interval",
          });
        } else {
          intervalDays = request.interval;
        }
      } else if (typeof request.interval === "string") {
        const normalized = request.interval.toLowerCase().trim() as BacktestInterval;
        if (normalized in INTERVAL_DAYS_MAP) {
          intervalDays = INTERVAL_DAYS_MAP[normalized];
        } else {
          const parsed = Number(request.interval);
          if (Number.isInteger(parsed) && parsed > 0) {
            intervalDays = parsed;
          } else {
            errors.push({
              code: "UNSUPPORTED_INTERVAL",
              message: `Interval '${request.interval}' is not supported. Supported intervals: ${SUPPORTED_BACKTEST_INTERVALS.join(", ")} or positive integer days`,
              field: "interval",
            });
          }
        }
      } else {
        errors.push({
          code: "UNSUPPORTED_INTERVAL",
          message: "Interval must be a string or number",
          field: "interval",
        });
      }

      // Check if interval is compatible with the date window
      if (intervalDays !== null && !isNaN(startDate.getTime()) && !isNaN(endDate.getTime()) && startDate < endDate) {
        const windowDays = Math.ceil(
          (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
        );
        if (intervalDays > windowDays) {
          errors.push({
            code: "UNSUPPORTED_INTERVAL_WINDOW",
            message: `Interval (${intervalDays} days) cannot exceed the backtest window duration (${windowDays} days)`,
            field: "interval",
          });
        }
      }
    }

    // Deposit amount validation
    const depositAmount = BigInt(request.depositAmount);
    if (depositAmount <= 0n) {
      errors.push({
        code: "INVALID_DEPOSIT_AMOUNT",
        message: "Deposit amount must be greater than zero",
        field: "depositAmount",
      });
    }

    // vault ID validation
    if (!request.vaultContractId || request.vaultContractId.trim().length === 0) {
      errors.push({
        code: "INVALID_VAULT_ID",
        message: "Vault contract ID must be a non-empty string",
        field: "vaultContractId",
      });
    }
  } catch (err) {
    // Catch unexpected errors
    if (err instanceof ValidationException) {
      errors.push(
        ...err.errors.map((e) => ({
          code: e.code,
          message: e.message,
        })),
      );
    } else {
      errors.push({
        code: "VALIDATION_ERROR",
        message: err instanceof Error ? err.message : "Unknown validation error",
      });
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Fetch backtest data from backend with validation
 *
 * @throws Error with specific validation message if request is invalid
 */
export async function fetchBacktestData(request: BacktestRequest): Promise<BacktestResult> {
  // Validate request
  const validation = validateBacktestRequest(request);
  if (!validation.isValid) {
    const errorMessage = validation.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`Backtest validation failed: ${errorMessage}`);
  }

  const params = new URLSearchParams({
    vaultContractId: request.vaultContractId,
    startDate: request.startDate,
    endDate: request.endDate,
    depositAmount: request.depositAmount.toString(),
  });

  const response = await fetch(`/api/backtest?${params}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Backtest failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as BacktestResult;
}

/**
 * Calculate compound interest from daily APY snapshots.
 * Used for client-side simulation with high precision.
 */
export function calculateCompoundInterest(
  initialAmount: bigint,
  snapshots: DailySnapshot[],
): DailySnapshot[] {
  if (snapshots.length === 0) return [];

  const results: DailySnapshot[] = [];
  let currentValue = initialAmount;

  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i];
    const dailyRate = snapshot.apy / 365 / 100;
    currentValue = (currentValue * BigInt(Math.round((1 + dailyRate) * 1e9))) / BigInt(1e9);

    results.push({
      date: snapshot.date,
      apy: snapshot.apy,
      equityValue: currentValue,
    });
  }

  return results;
}

/**
 * Calculate total return percentage from initial and final amounts.
 */
export function calculateTotalReturn(initial: bigint, final: bigint): number {
  if (initial === 0n) return 0;
  return (Number(final - initial) / Number(initial)) * 100;
}
