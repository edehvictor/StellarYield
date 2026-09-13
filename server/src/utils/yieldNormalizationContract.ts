/**
 * The yield normalization contract.
 *
 * Every yield number that crosses a module boundary — market-feed ingestion,
 * portfolio summaries, simulations, API responses — must be produced by the
 * helpers in this file. Feed ingestion and portfolio summaries are written by
 * different people at different times, and the only thing that keeps them
 * agreeing is a single definition of "what unit is this, and how many digits
 * does it carry".
 *
 * See `server/docs/yield-normalization-contract.md` for the prose version.
 */

/** APY is always a percent (6.75 means 6.75 %), carried to 2 decimals. */
export const APY_DECIMALS = 2;

/** USD amounts are carried to cents. */
export const USD_DECIMALS = 2;

/** One unit in the last place at `APY_DECIMALS`. */
export const APY_ULP = 10 ** -APY_DECIMALS;

/** One unit in the last place at `USD_DECIMALS`. */
export const USD_ULP = 10 ** -USD_DECIMALS;

export const YIELD_NORMALIZATION_CONTRACT = {
  version: "1.0.0",
  apy: {
    unit: "percent",
    decimals: APY_DECIMALS,
    /** Feeds publish basis points; percent = bps / 100. */
    fromBps: "bps / 100",
    /** Two APYs are in parity when they differ by less than half an ulp. */
    tolerance: APY_ULP / 2,
  },
  usd: {
    unit: "usd",
    decimals: USD_DECIMALS,
    tolerance: USD_ULP / 2,
  },
  rounding: "half-away-from-zero",
  /**
   * Round once, at the boundary. Intermediate arithmetic stays at full
   * precision; rounding an already-rounded value is what makes two paths that
   * "do the same thing" disagree in the second decimal.
   */
  roundingPolicy: "round-once-at-emit",
} as const;

export type YieldNormalizationContract = typeof YIELD_NORMALIZATION_CONTRACT;

/**
 * Half-away-from-zero rounding at a fixed number of decimals.
 *
 * Two deliberate differences from a bare `Math.round(v * 10 ** d) / 10 ** d`:
 *
 * 1. `Math.round` breaks ties towards +Infinity, so `0.125 -> 0.13` but
 *    `-0.125 -> -0.12`. A summary that negates a feed value (an outflow, a
 *    drawdown) would then disagree with the feed by an ulp. Ties here always
 *    move away from zero, so `round(-x) === -round(x)` holds.
 * 2. `1.005 * 100` is `100.49999999999999` in binary floating point, which
 *    rounds *down*. Re-reading the scaled value at 15 significant digits
 *    discards that representation error before the tie is decided.
 */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;

  const factor = 10 ** decimals;
  const scaled = Number((value * factor).toPrecision(15));
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);

  // Avoid handing back -0, which is !== 0 under Object.is and in snapshots.
  return rounded === 0 ? 0 : rounded / factor;
}

/** Converts a feed's basis points to percent. Exact — does not round. */
export function bpsToApyPercent(bps: number): number {
  return bps / 100;
}

/** Rounds a full-precision percent to the contract's APY precision. */
export function normalizeApyPercent(value: number): number {
  return roundTo(value, APY_DECIMALS);
}

/** Rounds a full-precision USD amount to the contract's USD precision. */
export function normalizeUsd(value: number): number {
  return roundTo(value, USD_DECIMALS);
}

/**
 * Weighted-average APY across positions, rounded once at the end.
 *
 * `weight` may be any non-negative measure (USD value, share count); weights
 * are normalized internally. Returns 0 when the weights sum to 0.
 */
export function blendApyPercent(
  parts: ReadonlyArray<{ apyPercent: number; weight: number }>,
): number {
  const totalWeight = parts.reduce((sum, p) => sum + (p.weight > 0 ? p.weight : 0), 0);
  if (totalWeight <= 0) return 0;

  const blended = parts.reduce(
    (sum, p) => (p.weight > 0 ? sum + (p.apyPercent * p.weight) / totalWeight : sum),
    0,
  );
  return normalizeApyPercent(blended);
}

/** True when `value` carries no more decimals than the contract allows. */
export function isAtApyPrecision(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value - roundTo(value, APY_DECIMALS)) <= 1e-9;
}

/** True when `value` carries no more decimals than the contract allows. */
export function isAtUsdPrecision(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value - roundTo(value, USD_DECIMALS)) <= 1e-9;
}

/** Number of decimals actually carried by `value`, capped at 12. */
export function decimalsOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  for (let d = 0; d <= 12; d += 1) {
    if (Math.abs(value - roundTo(value, d)) <= 1e-12) return d;
  }
  return 12;
}
