/**
 * Yield Strategy Backtester Service
 * Calculates compound interest from historical APY snapshots
 */

import type { BacktestRequest, BacktestResult, DailySnapshot } from "./types";

interface ValidationError {
    code: string;
    message: string;
    field?: string;
}

interface ValidationResult {
    isValid: boolean;
    errors: ValidationError[];
}

export function validateBacktestRequest(request: BacktestRequest): ValidationResult {
    const errors: ValidationError[] = [];
    const start = new Date(request.startDate);
    const end = new Date(request.endDate);
    const now = new Date();

    if (Number.isNaN(start.getTime())) {
        errors.push({
            code: "INVALID_START_DATE",
            message: "Start date must be a valid date.",
            field: "startDate",
        });
    }

    if (Number.isNaN(end.getTime())) {
        errors.push({
            code: "INVALID_END_DATE",
            message: "End date must be a valid date.",
            field: "endDate",
        });
    }

    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
        if (start >= end) {
            errors.push({
                code: "INVALID_DATE_RANGE",
                message: "Start date must be before end date.",
                field: "startDate",
            });
        }

        const maxWindowMs = 1000 * 60 * 60 * 24 * 365 * 2;
        if (end.getTime() - start.getTime() > maxWindowMs) {
            errors.push({
                code: "DATE_RANGE_TOO_LONG",
                message: "Maximum backtest window is 2 years.",
                field: "endDate",
            });
        }

        if (start > now || end > now) {
            errors.push({
                code: "FUTURE_DATE",
                message: "Backtest dates must be in the past.",
                field: "endDate",
            });
        }
    }

    if (request.depositAmount <= 0n) {
        errors.push({
            code: "INVALID_DEPOSIT_AMOUNT",
            message: "Deposit amount must be greater than zero.",
            field: "depositAmount",
        });
    }

    return { isValid: errors.length === 0, errors };
}

/**
 * Fetch backtest data from backend
 * Backend validates date inputs to prevent heavy unindexed queries
 */
export async function fetchBacktestData(request: BacktestRequest): Promise<BacktestResult> {
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
        throw new Error(`Backtest failed: ${response.statusText}`);
    }

    return (await response.json()) as BacktestResult;
}

/**
 * Calculate compound interest from daily APY snapshots
 * Used for client-side simulation
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
 * Calculate total return percentage
 */
export function calculateTotalReturn(initial: bigint, final: bigint): number {
    if (initial === 0n) return 0;
    return (Number(final - initial) / Number(initial)) * 100;
}
