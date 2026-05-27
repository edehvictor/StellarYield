export { default as BacktestPanel } from "./BacktestPanel";
export { fetchBacktestData, calculateCompoundInterest, calculateTotalReturn } from "./backtestService";
export type { BacktestRequest, BacktestResult, DailySnapshot } from "./types";

export { default as RebalanceBacktestPanel } from "./RebalanceBacktestPanel";
export { fetchRebalanceBacktest } from "./rebalanceBacktestService";
export type {
  RebalanceAllocationRule,
  RebalanceBacktestParams,
  RebalanceBacktestSnapshot,
  RebalanceEvent,
  RebalanceBacktestResult,
} from "./rebalanceBacktestService";
