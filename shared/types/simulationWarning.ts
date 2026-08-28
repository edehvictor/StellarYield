/**
 * Structured warning model for simulator and backtest outputs.
 *
 * Warnings are returned as structured objects rather than plain strings so that
 * client UIs can render them consistently (colour-coded by severity, grouped by
 * affected field, and paired with actionable remediation text) without parsing
 * free-form strings.
 *
 * Design principles:
 *  - `code`     — stable machine-readable identifier; never changes once shipped.
 *  - `severity` — three-tier scale that maps directly to UI colour tokens.
 *  - `field`    — optional pointer to the simulation input that triggered the warning.
 *  - `message`  — human-readable description of the issue.
 *  - `remediation` — short, actionable suggestion the user can act on immediately.
 */

/** Stable machine-readable warning codes. */
export type SimulationWarningCode =
  // Data quality
  | "STALE_DATA"               // Market / price data is older than the freshness threshold.
  | "INCOMPLETE_HISTORY"       // Historical data is too sparse to produce a reliable backtest.
  | "UNSUPPORTED_INTERVAL"     // Requested date range or rebalance interval is not supported.
  // Market conditions
  | "HIGH_VOLATILITY"          // Underlying asset(s) exhibit unusually high price volatility.
  | "HIGH_FEES"                // Estimated turnover/rebalance fees are disproportionately large.
  | "LIQUIDITY_RISK"           // A trade leg would consume a large fraction of available liquidity.
  // Concentration
  | "HIGH_CONCENTRATION"       // A single position exceeds the concentration threshold.
  // Deposit / routing
  | "HIGH_SLIPPAGE"            // Expected slippage is elevated due to deposit size.
  | "INSUFFICIENT_LIQUIDITY"   // Not enough liquidity to route the full deposit.
  | "UNSUPPORTED_STRATEGY"     // Strategy/asset combination is not recognised.
  | "ZERO_AMOUNT"              // Deposit amount is zero or negative.
  | "AMOUNT_TOO_LARGE";        // Deposit amount exceeds the simulation ceiling.

/** Visual severity tier — maps to UI colour tokens. */
export type SimulationWarningSeverity = "info" | "warning" | "critical";

/** A single structured warning emitted by a simulator or backtest engine. */
export interface SimulationWarning {
  /** Stable code the UI can branch on without string-parsing. */
  code: SimulationWarningCode;
  /** Visual severity tier. */
  severity: SimulationWarningSeverity;
  /**
   * Optional pointer to the simulation input field that triggered this warning
   * (e.g. "dataAgeSeconds", "allocations[0].liquidityUsd").
   */
  affectedField?: string;
  /** Human-readable description of the issue. */
  message: string;
  /** Short, actionable suggestion the user can act on immediately. */
  remediation: string;
}
