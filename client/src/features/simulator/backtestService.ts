/**
 * Yield Strategy Backtester Service
 * Calculates compound interest from historical APY snapshots
 */

import type { BacktestRequest, BacktestResult, DailySnapshot } from "./types";

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
