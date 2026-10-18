/**
 * Portfolio valuation and completeness model (#1660).
 *
 * In DeFi, oracle latency, missing feeds, or unlisted tokens mean that an asset's
 * current market price may be temporarily or permanently unavailable.
 *
 * This module cleanly separates:
 * 1. Genuine zero balances (deposited: 0, currentValue: 0, or user exited the position)
 * 2. Unpriced / unavailable holdings (user holds funds/shares, but price feed is missing/offline)
 * 3. Priced holdings (known positive or zero market valuation)
 *
 * It provides shared types and pure aggregation helpers so both client (Dashboard,
 * ExposureMap, Position tables) and server (PortfolioService, exports, reports)
 * compute identical completeness states and visibly incomplete totals.
 */

export type ValuationPriceStatus = "priced" | "unpriced" | "zero";

export type PortfolioValuationCompleteness =
  | "complete" // All holdings with active balances have known prices
  | "partial" // Mixed: some holdings are priced, but at least one is unpriced
  | "unavailable" // All non-zero holdings have unavailable prices
  | "empty"; // No active holdings

/** Generic input representing any position or holding. */
export interface PositionValuationInput {
  protocol: string;
  asset: string;
  deposited?: number | null;
  currentValue?: number | null;
  shares?: number | null;
  apy?: number | null;
  fetchedAt?: string | null;
  /** Explicit override or flag when price feed is known to be missing. */
  isPriceUnavailable?: boolean;
  /** Explicit price status from source data. */
  priceStatus?: ValuationPriceStatus;
  /** Optional reason for unavailable valuation (e.g., ORACLE_TIMEOUT). */
  unpricedReason?: string;
}

/** Resolved position with normalized valuation status. */
export interface ResolvedPositionValuation extends PositionValuationInput {
  deposited: number;
  currentValue: number | null;
  priceStatus: ValuationPriceStatus;
  isPriced: boolean;
  isUnpriced: boolean;
  isZeroBalance: boolean;
  /** Calculated P&L; null if valuation is unpriced. */
  pnlUsd: number | null;
}

/** Aggregate valuation summary across a portfolio. */
export interface PortfolioValuationSummary {
  /** Sum of currentValueUsd across all priced holdings. */
  pricedValueUsd: number;
  /**
   * Stated total value. Equals `pricedValueUsd` when complete or partial;
   * `null` when all holdings are unpriced.
   */
  totalValueUsd: number | null;
  /** Total deposited across ALL holdings (including unpriced). */
  totalDepositedUsd: number;
  /** Total deposited across PRICED holdings only (used for accurate P&L calculation). */
  pricedDepositedUsd: number;
  /**
   * Total yield earned on priced holdings (`pricedValueUsd - pricedDepositedUsd`).
   * `null` when no priced holdings exist.
   */
  yieldEarnedUsd: number | null;
  /** Completeness classification. */
  completeness: PortfolioValuationCompleteness;
  /** True strictly when all holdings are fully priced. */
  isComplete: boolean;
  /** Count of unpriced holdings. */
  unpricedCount: number;
  /** Count of priced holdings. */
  pricedCount: number;
  /** Count of genuine zero-balance holdings. */
  zeroCount: number;
  /** Total holdings count. */
  totalCount: number;
  /** Symbols of assets whose price is unavailable. */
  unpricedAssets: string[];
}

/**
 * Resolves the valuation status for an individual position.
 * Distinguishes genuine zero holdings from unpriced holdings.
 */
export function resolveValuationPriceStatus(
  deposited: number | null | undefined,
  currentValue: number | null | undefined,
  options?: {
    isPriceUnavailable?: boolean;
    priceStatus?: ValuationPriceStatus;
  },
): ValuationPriceStatus {
  // Explicit status takes precedence
  if (options?.priceStatus) {
    return options.priceStatus;
  }
  if (options?.isPriceUnavailable === true) {
    return "unpriced";
  }

  // If currentValue is explicitly null, undefined, or NaN, price is unavailable
  if (currentValue === null || currentValue === undefined || Number.isNaN(currentValue)) {
    return "unpriced";
  }

  const dep = typeof deposited === "number" && Number.isFinite(deposited) ? deposited : 0;
  const val = typeof currentValue === "number" && Number.isFinite(currentValue) ? currentValue : 0;

  // Genuine zero balance: deposited is 0 and current value is 0
  if (dep === 0 && val === 0) {
    return "zero";
  }

  return "priced";
}

/**
 * Normalizes an arbitrary position input into a resolved position with strict valuation typing.
 */
export function resolvePositionValuation(
  pos: PositionValuationInput,
): ResolvedPositionValuation {
  const deposited = typeof pos.deposited === "number" && Number.isFinite(pos.deposited)
    ? Math.max(0, pos.deposited)
    : 0;

  const priceStatus = resolveValuationPriceStatus(pos.deposited, pos.currentValue, {
    isPriceUnavailable: pos.isPriceUnavailable,
    priceStatus: pos.priceStatus,
  });

  const currentValue = priceStatus === "unpriced"
    ? null
    : typeof pos.currentValue === "number" && Number.isFinite(pos.currentValue)
      ? Math.max(0, pos.currentValue)
      : 0;

  const pnlUsd = priceStatus === "unpriced"
    ? null
    : (currentValue ?? 0) - deposited;

  return {
    ...pos,
    deposited,
    currentValue,
    priceStatus,
    isPriced: priceStatus === "priced",
    isUnpriced: priceStatus === "unpriced",
    isZeroBalance: priceStatus === "zero",
    pnlUsd,
  };
}

/**
 * Computes portfolio valuation summary, completeness tier, and fair yield breakdown.
 */
export function computePortfolioValuationSummary(
  positions: readonly PositionValuationInput[],
): PortfolioValuationSummary {
  if (!positions || positions.length === 0) {
    return {
      pricedValueUsd: 0,
      totalValueUsd: 0,
      totalDepositedUsd: 0,
      pricedDepositedUsd: 0,
      yieldEarnedUsd: 0,
      completeness: "empty",
      isComplete: true,
      unpricedCount: 0,
      pricedCount: 0,
      zeroCount: 0,
      totalCount: 0,
      unpricedAssets: [],
    };
  }

  const resolved = positions.map(resolvePositionValuation);

  let pricedValueUsd = 0;
  let totalDepositedUsd = 0;
  let pricedDepositedUsd = 0;
  let unpricedCount = 0;
  let pricedCount = 0;
  let zeroCount = 0;
  const unpricedAssetsSet = new Set<string>();

  for (const pos of resolved) {
    totalDepositedUsd += pos.deposited;

    if (pos.priceStatus === "unpriced") {
      unpricedCount++;
      if (pos.asset) {
        unpricedAssetsSet.add(pos.asset);
      }
    } else if (pos.priceStatus === "zero") {
      zeroCount++;
    } else {
      pricedCount++;
      pricedValueUsd += pos.currentValue ?? 0;
      pricedDepositedUsd += pos.deposited;
    }
  }

  const unpricedAssets = Array.from(unpricedAssetsSet);

  let completeness: PortfolioValuationCompleteness;
  let totalValueUsd: number | null;
  let yieldEarnedUsd: number | null;

  if (unpricedCount === 0) {
    completeness = "complete";
    totalValueUsd = pricedValueUsd;
    yieldEarnedUsd = pricedValueUsd - pricedDepositedUsd;
  } else if (pricedCount > 0) {
    // Mixed priced and unpriced holdings
    completeness = "partial";
    totalValueUsd = pricedValueUsd;
    yieldEarnedUsd = pricedValueUsd - pricedDepositedUsd;
  } else {
    // All active holdings are unpriced
    completeness = "unavailable";
    totalValueUsd = null;
    yieldEarnedUsd = null;
  }

  return {
    pricedValueUsd,
    totalValueUsd,
    totalDepositedUsd,
    pricedDepositedUsd,
    yieldEarnedUsd,
    completeness,
    isComplete: completeness === "complete",
    unpricedCount,
    pricedCount,
    zeroCount,
    totalCount: positions.length,
    unpricedAssets,
  };
}
