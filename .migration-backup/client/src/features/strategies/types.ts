/**
 * Strategy Comparison Types
 *
 * `StrategyRiskData` mirrors the fields surfaced by the server's risk-scoring
 * and leaderboard routes. Every field that may be unavailable is typed as
 * `T | null` so the UI can branch explicitly on missing data instead of
 * accidentally treating `0` or `undefined` as "no data".
 */

export type RiskLabel = "Low" | "Medium" | "High";
export type DataFreshness = "fresh" | "stale" | "unavailable";

export interface StrategyRiskData {
  /**
   * Composite risk score 1–10.  `null` means it could not be computed
   * (e.g. TVL data is missing or the oracle is down).
   */
  riskScore: number | null;
  /** Human-readable risk label derived from riskScore.  `null` when score is null. */
  riskLabel: RiskLabel | null;
  /**
   * Annualised IL volatility percentage.  `null` means the value has not
   * been reported for this strategy.
   */
  volatilityPct: number | null;
  /**
   * Liquidity depth in USD.  `null` means TVL data is unavailable.
   */
  liquidityUsd: number | null;
  /**
   * Freshness of the underlying data feed.
   * - "fresh"       — data is within the acceptable staleness window
   * - "stale"       — data is older than the acceptable window but present
   * - "unavailable" — data has never arrived or the feed is down
   */
  freshness: DataFreshness;
  /** ISO-8601 timestamp of the last successful data fetch, or null. */
  lastFetchedAt: string | null;
}

export interface StrategyComparison {
  id: string;
  name: string;
  strategyType: string;
  apy: number;
  /** When null the risk section renders in a missing-data state. */
  risk: StrategyRiskData | null;
}

/**
 * Sort keys supported by the comparison table.  When the field is null for a
 * strategy, that strategy is sorted to the bottom to avoid unpredictable
 * reordering during live data feeds.
 */
export type StrategyComparisonSortKey =
  | "apy"
  | "riskScore"
  | "volatilityPct"
  | "liquidityUsd";
