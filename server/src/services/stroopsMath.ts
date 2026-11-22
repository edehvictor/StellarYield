/**
 * Checked, integer-only arithmetic for zap quote / transaction review amounts (#1890).
 *
 * Rounding policy (documented, deterministic):
 *  - Amounts are non-negative integer strings of stroops, parsed with BigInt.
 *    Floating point is never used for token amounts.
 *  - Valid input range is [1, I128_MAX]; zero, negative, non-integer and
 *    oversized values are rejected (a Soroban token amount is an i128).
 *  - Slippage fractions are rounded to the nearest 1e-6 (one part per million)
 *    BEFORE being applied, so binary float noise (e.g. `1 - 0.07`) can never
 *    shift the result by one unit.
 *  - The guaranteed minimum output is rounded DOWN (floor) so the user is never
 *    promised more than the quote can deliver.
 *  - Every product is computed in BigInt, so it cannot overflow or lose
 *    precision; results are re-checked against I128_MAX.
 */

/** Largest value a Soroban i128 token amount can hold. */
export const I128_MAX = (BigInt(1) << BigInt(127)) - BigInt(1);

/** Slippage resolution: parts per million. */
export const SLIPPAGE_PPM_SCALE = BigInt(1_000_000);

/** Maximum fraction (100%) representable by {@link applySlippageFloor}. */
const MAX_SLIPPAGE_FRACTION = 1;

export type StroopsMathErrorCode =
  | "INVALID_AMOUNT"
  | "AMOUNT_NOT_POSITIVE"
  | "AMOUNT_OVERFLOW";

export class StroopsMathError extends Error {
  readonly code: StroopsMathErrorCode;
  constructor(code: StroopsMathErrorCode, message: string) {
    super(message);
    this.name = "StroopsMathError";
    this.code = code;
  }
}

/**
 * Strictly parses a stroop amount. Accepts only `^\d+$` (no sign, whitespace,
 * decimals or exponent) with a value in [1, I128_MAX].
 */
export function parseStroopsAmount(raw: unknown): bigint {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new StroopsMathError(
      "INVALID_AMOUNT",
      "amountInStroops must be a non-negative integer string.",
    );
  }
  const value = BigInt(raw);
  if (value <= BigInt(0)) {
    throw new StroopsMathError(
      "AMOUNT_NOT_POSITIVE",
      "amountInStroops must be greater than zero.",
    );
  }
  if (value > I128_MAX) {
    throw new StroopsMathError(
      "AMOUNT_OVERFLOW",
      "amountInStroops exceeds the maximum supported amount (i128).",
    );
  }
  return value;
}

/**
 * Normalizes a slippage fraction to [0, 1]. Non-finite input (NaN, ±Infinity)
 * yields `fallback`, so a bad value can never propagate into amount math.
 */
export function sanitizeSlippageFraction(value: number | undefined, fallback: number): number {
  const v = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const f = Number.isFinite(v) ? v : 0;
  return Math.min(Math.max(f, 0), MAX_SLIPPAGE_FRACTION);
}

/** Converts a slippage fraction to integer parts-per-million (nearest). */
export function slippageToPpm(fraction: number): bigint {
  return BigInt(Math.round(sanitizeSlippageFraction(fraction, 0) * 1_000_000));
}

/**
 * `floor(expectedOut * (1 - slippage))` using integer math only.
 * Zero in → zero out; 100% slippage → zero; result is always within
 * [0, expectedOut].
 */
export function applySlippageFloor(expectedOut: bigint, slippageFraction: number): bigint {
  if (expectedOut < BigInt(0)) {
    throw new StroopsMathError("INVALID_AMOUNT", "expected output must not be negative.");
  }
  if (expectedOut > I128_MAX) {
    throw new StroopsMathError("AMOUNT_OVERFLOW", "expected output exceeds i128.");
  }
  const keepPpm = SLIPPAGE_PPM_SCALE - slippageToPpm(slippageFraction);
  return (expectedOut * keepPpm) / SLIPPAGE_PPM_SCALE;
}

/**
 * Checked `amount * numerator / denominator` (floor). Returns `null` when the
 * denominator is zero, instead of dividing by zero. Throws on negative inputs
 * or a result above I128_MAX.
 */
export function mulDivFloor(amount: bigint, numerator: bigint, denominator: bigint): bigint | null {
  if (amount < BigInt(0) || numerator < BigInt(0) || denominator < BigInt(0)) {
    throw new StroopsMathError("INVALID_AMOUNT", "mulDiv operands must not be negative.");
  }
  if (denominator === BigInt(0)) return null;
  const result = (amount * numerator) / denominator;
  if (result > I128_MAX) {
    throw new StroopsMathError("AMOUNT_OVERFLOW", "result exceeds i128.");
  }
  return result;
}
