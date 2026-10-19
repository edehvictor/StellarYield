import { apiUrl } from "../../lib/api";
import type { SimulationWarning } from "../../../../shared/types/simulationWarning";

// Re-export for convenience.
export type { SimulationWarning } from "../../../../shared/types/simulationWarning";

export interface RebalanceAllocationRule {
  label: string;
  targetWeight: number;
  /** Annualised %. May be negative, down to -100. */
  apy: number;
  /** Optional per-day APY series; entries may be negative to model a loss. */
  dailyApy?: number[];
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
  /** Days the rebalanced portfolio's blended yield was negative. Absent on older servers. */
  negativeYieldDays?: number;
  /** Largest peak-to-trough fall of the rebalanced portfolio, as a positive %. Absent on older servers. */
  maxDrawdownPct?: number;
  /** Largest peak-to-trough fall of the passive benchmark, as a positive %. Absent on older servers. */
  passiveMaxDrawdownPct?: number;
  snapshots: RebalanceBacktestSnapshot[];
  rebalanceEvents: RebalanceEvent[];
  warnings: SimulationWarning[];
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
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      details?: unknown;
    };
    // The server explains *why* a request was invalid in `details`; showing
    // only "Invalid backtest parameters" leaves the user guessing.
    const details = Array.isArray(body.details)
      ? body.details.filter((d): d is string => typeof d === "string").slice(0, 3)
      : [];
    const headline = body.error ?? `Backtest failed: ${res.statusText}`;
    throw new Error(details.length > 0 ? `${headline}: ${details.join(" ")}` : headline);
  }

  return (await res.json()) as RebalanceBacktestResult;
}
