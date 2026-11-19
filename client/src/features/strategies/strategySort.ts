/**
 * Strategy Comparison Sorting Utilities
 *
 * Strategies with null or non-finite (NaN, ±Infinity) values in the sort
 * field are always placed at the bottom (stable, deterministic) so incomplete risk data never causes
 * unpredictable reordering of visible items.
 */

import { comparableValue } from "./strategyComparisonMath";
import type { StrategyComparison, StrategyComparisonSortKey } from "./types";

/**
 * Return a sorted copy of `strategies`. Null values sort to the bottom.
 * Ties in the primary key are broken by `apy` descending.
 */
export function sortStrategies(
  strategies: StrategyComparison[],
  sortKey: StrategyComparisonSortKey,
  direction: "asc" | "desc" = "desc",
): StrategyComparison[] {
  const getValue = (s: StrategyComparison): number | null => {
    switch (sortKey) {
      case "apy":
        return comparableValue(s.apy);
      case "riskScore":
        return comparableValue(s.risk?.riskScore);
      case "volatilityPct":
        return comparableValue(s.risk?.volatilityPct);
      case "liquidityUsd":
        return comparableValue(s.risk?.liquidityUsd);
    }
  };

  return [...strategies].sort((a, b) => {
    const av = getValue(a);
    const bv = getValue(b);

    // Both null — keep original order
    if (av === null && bv === null) return 0;
    // Null always sorts to bottom regardless of direction
    if (av === null) return 1;
    if (bv === null) return -1;

    const primaryDiff = direction === "desc" ? bv - av : av - bv;
    if (primaryDiff !== 0) return primaryDiff;

    // Tie-break: higher APY first; a non-finite APY never wins a tie (#1922).
    const aApy = comparableValue(a.apy);
    const bApy = comparableValue(b.apy);
    if (aApy === null && bApy === null) return 0;
    if (aApy === null) return 1;
    if (bApy === null) return -1;
    return bApy - aApy;
  });
}
