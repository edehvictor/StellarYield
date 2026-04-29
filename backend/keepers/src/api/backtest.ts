/**
 * Backtest API Endpoint
 * GET /api/backtest - Calculate compound interest from historical APY snapshots
 */

import { Router, type Request, type Response } from "express";
import { logger } from "../utils/logger";

interface BacktestQuery {
    vaultContractId: string;
    startDate: string;
    endDate: string;
    depositAmount: string;
}

interface DailySnapshot {
    date: string;
    apy: number;
    equityValue: string;
}

interface BacktestResponse {
    vaultContractId: string;
    startDate: string;
    endDate: string;
    initialDeposit: string;
    finalValue: string;
    totalReturn: number;
    snapshots: DailySnapshot[];
}

/**
 * Validate date inputs to prevent heavy unindexed queries
 */
function validateDateRange(startDate: string, endDate: string): void {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const now = new Date();

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new Error("Invalid date format");
    }

    if (start >= end) {
        throw new Error("Start date must be before end date");
    }

    if (start > now) {
        throw new Error("Start date cannot be in the future");
    }

    // Limit query range to 2 years
    const maxRange = 2 * 365 * 24 * 60 * 60 * 1000;
    if (end.getTime() - start.getTime() > maxRange) {
        throw new Error("Date range cannot exceed 2 years");
    }
}

/**
 * Calculate compound interest from daily APY snapshots
 * In production: fetch from indexed database with proper query optimization
 */
function calculateCompoundInterest(
    initialAmount: bigint,
    snapshots: Array<{ date: string; apy: number }>,
): DailySnapshot[] {
    if (snapshots.length === 0) return [];

    const results: DailySnapshot[] = [];
    let currentValue = initialAmount;

    for (const snapshot of snapshots) {
        const dailyRate = snapshot.apy / 365 / 100;
        const multiplier = BigInt(Math.round((1 + dailyRate) * 1e9));
        currentValue = (currentValue * multiplier) / BigInt(1e9);

        results.push({
            date: snapshot.date,
            apy: snapshot.apy,
            equityValue: currentValue.toString(),
        });
    }

    return results;
}

/**
 * Mock historical APY data
 * In production: query from PostgreSQL with proper indexing
 */
function getMockHistoricalData(
    startDate: string,
    endDate: string,
): Array<{ date: string; apy: number }> {
    const snapshots: Array<{ date: string; apy: number }> = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        snapshots.push({
            date: d.toISOString().split("T")[0],
            apy: 8 + Math.random() * 4, // Mock: 8-12% APY
        });
    }

    return snapshots;
}

export function createBacktestRouter(): Router {
    const router = Router();

    router.get("/backtest", (req: Request, res: Response) => {
        try {
            const { vaultContractId, startDate, endDate, depositAmount } = req.query as BacktestQuery;

            if (!vaultContractId || !startDate || !endDate || !depositAmount) {
                res.status(400).json({ error: "Missing required parameters" });
                return;
            }

            validateDateRange(startDate, endDate);

            const initialDeposit = BigInt(depositAmount);
            const historicalData = getMockHistoricalData(startDate, endDate);
            const snapshots = calculateCompoundInterest(initialDeposit, historicalData);

            const finalValue = snapshots.length > 0 ? BigInt(snapshots[snapshots.length - 1].equityValue) : initialDeposit;
            const totalReturn = Number((finalValue - initialDeposit) * BigInt(10000)) / Number(initialDeposit) / 100;

            const response: BacktestResponse = {
                vaultContractId,
                startDate,
                endDate,
                initialDeposit: initialDeposit.toString(),
                finalValue: finalValue.toString(),
                totalReturn,
                snapshots,
            };

            res.json(response);
            logger.info({ vaultContractId, startDate, endDate }, "Backtest completed");
        } catch (error) {
            logger.error(error, "Backtest error");
            res.status(400).json({ error: error instanceof Error ? error.message : "Backtest failed" });
        }
    });

    return router;
}
