/**
 * Strategy Comparison Sorting Utilities
 *
 * Strategies with null values in the sort field are always placed at the
 * bottom (stable, deterministic) so incomplete risk data never causes
 * unpredictable reordering of visible items.
 */

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
        return s.apy;
      case "riskScore":
        return s.risk?.riskScore ?? null;
      case "volatilityPct":
        return s.risk?.volatilityPct ?? null;
      case "liquidityUsd":
        return s.risk?.liquidityUsd ?? null;
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

    // Tie-break: higher APY first
    return b.apy - a.apy;
  });
}
