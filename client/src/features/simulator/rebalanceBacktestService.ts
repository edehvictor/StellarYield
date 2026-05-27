import { apiUrl } from "../../lib/api";

export interface RebalanceAllocationRule {
  label: string;
  targetWeight: number;
  apy: number;
  liquidityUsd?: number;
}

export interface RebalanceBacktestParams {
  initialValueUsd: number;
  startDate: string;
  endDate: string;
  allocations: RebalanceAllocationRule[];
  strategy: "schedule" | "threshold";
  rebalanceIntervalDays?: number;
  driftThresholdPct?: number;
  feeBps?: number;
}

export interface RebalanceBacktestSnapshot {
  date: string;
  portfolioValue: number;
  passiveValue: number;
  rebalanced: boolean;
  blendedApyPct: number;
}

export interface RebalanceEvent {
  date: string;
  reason: string;
  maxDriftPct: number;
  feeUsd: number;
}

export interface RebalanceBacktestResult {
  isSimulationOnly: true;
  startDate: string;
  endDate: string;
  initialValueUsd: number;
  finalPortfolioValue: number;
  finalPassiveValue: number;
  portfolioReturnPct: number;
  passiveReturnPct: number;
  outperformancePct: number;
  rebalanceCount: number;
  totalFeesUsd: number;
  snapshots: RebalanceBacktestSnapshot[];
  rebalanceEvents: RebalanceEvent[];
}

export async function fetchRebalanceBacktest(
  params: RebalanceBacktestParams,
): Promise<RebalanceBacktestResult> {
  const res = await fetch(apiUrl("/api/simulator/rebalance-backtest"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Backtest failed: ${res.statusText}`,
    );
  }

  return (await res.json()) as RebalanceBacktestResult;
}
