/**
 * Precision-safe APY formatting (#1070).
 *
 * A fixed `toFixed(2)` collapses sub-basis-point rates (e.g. 0.003%) to a
 * misleading "0.00%", and prints an unwieldy digit string for very large
 * synthetic/stress-test rates (e.g. 500000.123456%). `formatApy()` adapts
 * decimal precision to the magnitude of the value so labels stay
 * meaningful at both ends — never a misleading zero, never an unreadable
 * sprawl of digits — and is meant to be the single formatting rule shared
 * by chart tick labels, tooltips, and summary cards.
 *
 * APY values throughout this codebase are percentage numbers (6.5 = 6.5%),
 * not fractions, so magnitude bands below are in those same units.
 */

export interface FormatApyOptions {
  /** Append a trailing '%' sign. Default: true. */
  suffix?: boolean;
  /** Show a leading '+' for positive values (useful for deviations). Default: false. */
  showPositiveSign?: boolean;
}

/** Below this magnitude (%), a fixed 2-decimal format would round to "0.00". */
const TINY_THRESHOLD = 0.01;
/** At or above this magnitude (%), switch to compact K/M/B grouping. */
const LARGE_THRESHOLD = 10_000;
/** Hard cap on decimal places for extremely tiny values, to keep labels bounded. */
const MAX_TINY_DECIMALS = 10;

/**
 * Format an APY percentage value for display, adapting decimal precision to
 * magnitude so tiny values never collapse to a misleading "0.00%" and
 * unusually large values never sprawl into an unreadable digit string.
 *
 * @param value APY as a percentage (e.g. 6.5 = 6.5%)
 */
export function formatApy(value: number, options: FormatApyOptions = {}): string {
  const { suffix = true, showPositiveSign = false } = options;

  if (!Number.isFinite(value)) {
    return suffix ? "—%" : "—";
  }

  if (value === 0) {
    return `${"0.00"}${suffix ? "%" : ""}`;
  }

  const sign = value > 0 && showPositiveSign ? "+" : value < 0 ? "-" : "";
  const abs = Math.abs(value);

  let formatted: string;
  if (abs < TINY_THRESHOLD) {
    formatted = formatSignificant(abs);
  } else if (abs >= LARGE_THRESHOLD) {
    formatted = formatCompactLarge(abs);
  } else {
    formatted = abs.toFixed(abs < 1 ? 4 : 2);
  }

  return `${sign}${formatted}${suffix ? "%" : ""}`;
}

/**
 * Format a positive sub-threshold value with enough decimal places to show
 * its first couple of significant digits, instead of a fixed decimal count
 * that would round it to zero.
 */
function formatSignificant(value: number): string {
  if (value === 0) return "0.00";
  const magnitude = Math.floor(Math.log10(value));
  // Enough decimals to reveal ~2 significant digits past the leading zeros,
  // capped so extremely tiny values don't produce unbounded strings.
  const decimals = Math.min(Math.max(2, -magnitude + 1), MAX_TINY_DECIMALS);
  return value.toFixed(decimals);
}

/** Format a large positive value with compact K/M/B grouping. */
function formatCompactLarge(value: number): string {
  const units: Array<[number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [threshold, unit] of units) {
    if (value >= threshold) {
      return `${(value / threshold).toFixed(2)}${unit}`;
    }
  }
  return value.toFixed(2);
}

/**
 * Format an APY deviation (e.g. a source's distance from the mean), with an
 * explicit sign so positive and negative deviations are unambiguous.
 */
export function formatApyDeviation(value: number): string {
  return formatApy(value, { suffix: false, showPositiveSign: true });
}

/**
 * Shared reward-rate display helper (#1150).
 *
 * Before this, reward/APY rates were formatted ad hoc across dashboard,
 * strategy, and vault-card panels — most with a bare `value.toFixed(2)}%`
 * that (a) diverges from `formatApy`'s magnitude-adaptive precision (so a
 * tiny rate silently prints "0.00%" in some panels but not others), and
 * (b) has no explicit handling for a missing/unavailable rate, so a
 * `null`/`undefined` value either crashes `toFixed` or silently renders
 * blank depending on the call site's null-guard (or lack of one).
 *
 * `formatRewardRate` is the single entry point every panel should use for a
 * reward-rate percentage display: it normalizes null/undefined/non-finite
 * values to one explicit "unavailable" label, treats zero as a real,
 * meaningful rate (not the same as unavailable), and otherwise defers to
 * `formatApy` so precision stays consistent with the chart/tooltip call
 * sites that already used it.
 *
 * Note on APR vs APY: this codebase's yield/reward values
 * (`NormalizedYield.apy`, `.netApy`, `.totalApy`, `.rewards[].apy`,
 * `rewardOffsetApy`, etc.) are exclusively APY — there is no APR
 * representation or APR→APY conversion anywhere in this codebase's data
 * model. `formatRewardRate` therefore does not attempt to distinguish or
 * convert between the two; it takes a raw APY percentage value and formats
 * it. If an APR representation is introduced later, the conversion should
 * be applied by the caller (or a future `type` parameter added here) rather
 * than guessed at in this helper.
 */
export interface FormatRewardRateOptions extends FormatApyOptions {
  /** Label shown for a null/undefined/non-finite rate. Default: "—". */
  unavailableLabel?: string;
}

export function formatRewardRate(
  value: number | null | undefined,
  options: FormatRewardRateOptions = {},
): string {
  const { unavailableLabel = "—", ...apyOptions } = options;

  if (value === null || value === undefined || !Number.isFinite(value)) {
    return unavailableLabel;
  }

  return formatApy(value, apyOptions);
}