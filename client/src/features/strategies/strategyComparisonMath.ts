/**
 * Strategy comparison boundary-value math (#1922).
 *
 * Every number the comparison page displays, sorts on, or exports passes
 * through these helpers so zero, minimum, maximum, and near-limit values are
 * handled the same way everywhere. See docs/strategy-comparison-boundary-values.md.
 *
 * Rounding: half-up (away from zero) to two decimal places, applied once at
 * display/export time and never to an intermediate value.
 *
 * Checked arithmetic: a non-finite input, a value outside its documented
 * range, or a sum that would leave the safe-integer range throws
 * `StrategyComparisonCalculationError` instead of returning NaN, Infinity,
 * or a silently wrapped value.
 */

/** 100% expressed in basis points. A single fee can never exceed this. */
export const MAX_FEE_BPS = 10_000;
/** Management + performance fee together can never exceed 2 × 100%. */
export const MAX_FEE_DRAG_BPS = MAX_FEE_BPS * 2;
/** Risk score scale shown on the comparison card ("Score: n/100"). */
export const MIN_RISK_SCORE = 0;
export const MAX_RISK_SCORE = 100;
/** Largest USD amount accepted for TVL or liquidity. */
export const MAX_USD_AMOUNT = Number.MAX_SAFE_INTEGER;

export class StrategyComparisonCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyComparisonCalculationError";
  }
}

function fail(message: string): never {
  throw new StrategyComparisonCalculationError(message);
}

/** Rounds half-up (away from zero) to `decimals` places without float drift. */
export function roundHalfUp(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) fail(`cannot round a non-finite value (${value})`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
    fail(`decimals must be an integer between 0 and 8 (${decimals})`);
  }
  const factor = 10 ** decimals;
  const sign = value < 0 ? -1 : 1;
  // EPSILON corrects binary representations such as 1.005 → 1.00499999…
  const rounded = Math.round(Math.abs(value) * factor * (1 + Number.EPSILON)) / factor;
  // Avoid returning -0.
  return rounded === 0 ? 0 : sign * rounded;
}

/** A fee in basis points: an integer from 0 to 10,000 inclusive. */
export function assertFeeBps(value: unknown, field = "fee"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${field} must be a finite number of basis points`);
  }
  if (!Number.isInteger(value)) fail(`${field} must be a whole number of basis points`);
  if (value < 0 || value > MAX_FEE_BPS) {
    fail(`${field} must be between 0 and ${MAX_FEE_BPS} bps (${value})`);
  }
  return value;
}

/** Checked sum of the two strategy fees, within [0, MAX_FEE_DRAG_BPS]. */
export function checkedFeeDragBps(managementFeeBps: unknown, performanceFeeBps: unknown): number {
  const total =
    assertFeeBps(managementFeeBps, "managementFeeBps") +
    assertFeeBps(performanceFeeBps, "performanceFeeBps");
  if (total > MAX_FEE_DRAG_BPS) fail(`fee drag exceeds ${MAX_FEE_DRAG_BPS} bps (${total})`);
  return total;
}

/** Basis points to a percentage, rounded half-up to two decimals: 125 → 1.25. */
export function bpsToPercent(bps: unknown, field = "fee"): number {
  return roundHalfUp(assertFeeBps(bps, field) / 100, 2);
}

/** A non-negative, finite USD amount no larger than MAX_USD_AMOUNT. */
export function assertUsdAmount(value: unknown, field = "amount"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${field} must be a finite USD amount`);
  }
  if (value < 0) fail(`${field} cannot be negative (${value})`);
  if (value > MAX_USD_AMOUNT) fail(`${field} exceeds the maximum supported amount`);
  return value;
}

/** A risk score on the 0–100 scale the card shows. */
export function assertRiskScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("riskScore must be a finite number");
  }
  if (value < MIN_RISK_SCORE || value > MAX_RISK_SCORE) {
    fail(`riskScore must be between ${MIN_RISK_SCORE} and ${MAX_RISK_SCORE} (${value})`);
  }
  return value;
}

/** A finite APY percentage (may be negative for a losing strategy). */
export function assertApy(value: unknown, field = "apy"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${field} must be a finite percentage`);
  }
  return value;
}

/** An APY formatted to two decimals with half-up rounding: 4.005 → "4.01". */
export function formatApy(value: number): string {
  return roundHalfUp(assertApy(value), 2).toFixed(2);
}

/**
 * Compact USD for the comparison card: $0.00-$999.99, then $1.0K-$999.9K
 * (one decimal), then $1.00M and up (two decimals), all rounded half-up. A
 * value that rounds up into the next tier is shown in that tier, so 999,950
 * renders as "$1.00M" and 999.995 as "$1.0K", never "$1000.0K" or "$1000.00".
 */
export function formatComparisonCurrency(value: number): string {
  const amount = assertUsdAmount(value, "liquidityUsd");
  if (amount >= 1_000_000) return `$${roundHalfUp(amount / 1_000_000, 2).toFixed(2)}M`;
  const dollars = roundHalfUp(amount, 2);
  if (dollars >= 1_000) {
    const thousands = roundHalfUp(amount / 1_000, 1);
    // 999,950 rounds to 1,000.0K: promote it to the next tier instead.
    return thousands >= 1_000 ? "$1.00M" : `$${thousands.toFixed(1)}K`;
  }
  return `$${dollars.toFixed(2)}`;
}

/**
 * A sortable numeric value, or null when it cannot be compared safely
 * (null, undefined, NaN, ±Infinity). Null values sort to the bottom.
 */
export function comparableValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
