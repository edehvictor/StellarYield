/**
 * Yield Strategy Backtester Types
 */

export interface BacktestRequest {
    vaultContractId: string;
    startDate: string; // ISO date
    endDate: string; // ISO date
    depositAmount: bigint;
}

export interface DailySnapshot {
    date: string;
    apy: number;
    equityValue: bigint;
}

export interface BacktestResult {
    vaultContractId: string;
    startDate: string;
    endDate: string;
    initialDeposit: bigint;
    finalValue: bigint;
    totalReturn: number; // percentage
    snapshots: DailySnapshot[];
}
