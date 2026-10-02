/**
 * Deterministic multi-key sort helpers for dashboard tables (#1118).
 *
 * Tie-breaking contract (documented per issue acceptance criteria):
 *   1. Primary key comparison via the supplied comparator (direction-aware).
 *   2. Final fallback: `tiebreakId` — a unique-per-row string compared
 *      ALWAYS ascending and direction-independent, so equal-value rows
 *      render in the same order regardless of the order the backend
 *      returned them on any given refresh.
 *
 * All helpers copy the input before sorting; arrays are never mutated.
 * For multi-level ordering, compose the extra keys inside the comparator
 * before the final `tiebreakId` fallback is applied.
 */

export type SortDirection = "asc" | "desc";

/** Direction multiplier: `asc` → 1, `desc` → -1. */
export function directionFactor(direction: SortDirection): 1 | -1 {
  return direction === "desc" ? -1 : 1;
}

/** Locale-aware string comparison (ascending). */
export function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Numeric comparison (ascending); NaN is treated as equal to itself. */
export function compareNumbers(a: number, b: number): number {
  if (Number.isNaN(a) && Number.isNaN(b)) return 0;
  if (Number.isNaN(a)) return 1;
  if (Number.isNaN(b)) return -1;
  return a - b;
}

/**
 * Return a sorted copy of `items`.
 *
 * `comparator` decides the primary (and any intermediate) ordering; when it
 * returns 0, rows are ordered ascending by `tiebreakId(item)`, which must be
 * unique per row (e.g. `protocol-asset` slug, `providerId`, `strategyId`).
 * The final tiebreak is deliberately direction-independent so toggling sort
 * direction never reshuffles equal-value rows relative to each other.
 */
export function stableSort<T>(
  items: readonly T[],
  comparator: (a: T, b: T) => number,
  tiebreakId: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => {
    const primary = comparator(a, b);
    if (primary !== 0) return primary;
    return tiebreakId(a).localeCompare(tiebreakId(b));
  });
}
